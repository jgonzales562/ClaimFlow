import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const dataDir = join(repoRoot, ".postgres-data");
const logFile = join(dataDir, "postgres.log");
const defaultHost = "localhost";
const defaultPort = 55432;
const pidFile = join(dataDir, "postmaster.pid");

tryLoadEnvFile(join(repoRoot, ".env"));

const localDbConfig = readLocalDbConfig();
const postgresBin = findExecutable("postgres");
const socketFile = join(dataDir, `.s.PGSQL.${localDbConfig.port}`);
const socketLockFile = `${socketFile}.lock`;

const command = process.argv[2];

if (!command || !["start", "stop", "restart", "status"].includes(command)) {
  printUsage();
  process.exit(command ? 1 : 0);
}

switch (command) {
  case "start":
    startLocalPostgres();
    break;
  case "stop":
    stopLocalPostgres();
    break;
  case "restart":
    stopLocalPostgres({ allowMissing: true });
    startLocalPostgres();
    break;
  case "status":
    printStatus();
    break;
  default:
    printUsage();
    process.exit(1);
}

function startLocalPostgres() {
  assertDataDirExists();

  const state = inspectClusterState();
  if (state.running) {
    process.stdout.write(
      `Local Postgres is already running on ${localDbConfig.host}:${localDbConfig.port}${
        state.pid ? ` (pid ${state.pid})` : ""
      }.\n`,
    );
    return;
  }

  cleanupStaleArtifacts(state);

  const logFd = openSync(logFile, "a");
  const child = spawn(
    postgresBin,
    [
      "-D",
      dataDir,
      "-p",
      String(localDbConfig.port),
      "-k",
      dataDir,
      "-h",
      localDbConfig.host,
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );

  closeSync(logFd);
  child.unref();

  waitForReadiness();
  process.stdout.write(
    `Started local Postgres on ${localDbConfig.host}:${localDbConfig.port} using ${dataDir}.\n`,
  );
}

function stopLocalPostgres({ allowMissing = false } = {}) {
  assertDataDirExists();

  const state = inspectClusterState();
  if (!state.running) {
    cleanupStaleArtifacts(state);
    if (allowMissing) {
      process.stdout.write("Local Postgres is already stopped.\n");
      return;
    }

    process.stderr.write("Local Postgres is not running.\n");
    process.exit(1);
  }

  if (!state.pid) {
    process.stderr.write("Local Postgres is accepting connections, but no cluster pid was found.\n");
    process.exit(1);
  }

  process.kill(state.pid, "SIGINT");

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) {
      cleanupStaleArtifacts({ ...state, running: false });
      process.stdout.write("Stopped local Postgres.\n");
      return;
    }
    sleep(250);
  }

  process.stderr.write(`Timed out waiting for local Postgres pid ${state.pid} to stop.\n`);
  process.exit(1);
}

function printStatus() {
  assertDataDirExists();

  const state = inspectClusterState();
  if (state.running) {
    process.stdout.write(
      `Local Postgres is running on ${localDbConfig.host}:${localDbConfig.port}${
        state.pid ? ` (pid ${state.pid})` : ""
      }.\n`,
    );
    return;
  }

  if (state.pid && !state.running) {
    process.stdout.write(
      `Local Postgres is stopped, but stale cluster artifacts were found for pid ${state.pid}.\n`,
    );
    return;
  }

  process.stdout.write("Local Postgres is stopped.\n");
}

function inspectClusterState() {
  const pidFromFile = readClusterPid();
  const pidFromProcess = findClusterProcessPid();
  const pid = pidFromFile && isProcessAlive(pidFromFile) ? pidFromFile : pidFromProcess;
  const acceptingConnections = isAcceptingConnections();
  const running = acceptingConnections || (pid ? isProcessAlive(pid) : false);

  return {
    pid,
    running,
    acceptingConnections,
    hasPidFile: existsSync(pidFile),
    hasSocketFile: existsSync(socketFile),
    hasSocketLockFile: existsSync(socketLockFile),
  };
}

function cleanupStaleArtifacts(state) {
  if (state.running) {
    return;
  }

  for (const path of [pidFile, socketFile, socketLockFile]) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      process.stderr.write(`Failed to remove stale cluster file ${path}: ${String(error)}\n`);
      process.exit(1);
    }
  }
}

function readClusterPid() {
  if (!existsSync(pidFile)) {
    return null;
  }

  const contents = readFileSync(pidFile, "utf8");
  const [firstLine] = contents.split("\n");
  if (!firstLine) {
    return null;
  }

  const pid = Number.parseInt(firstLine, 10);
  return Number.isFinite(pid) ? pid : null;
}

function waitForReadiness() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (isAcceptingConnections()) {
      return;
    }
    sleep(250);
  }

  process.stderr.write(
    `Timed out waiting for local Postgres on ${localDbConfig.host}:${localDbConfig.port} to accept connections.\n`,
  );
  process.exit(1);
}

function isAcceptingConnections() {
  try {
    execFileSync(
      "/usr/bin/pg_isready",
      ["-h", localDbConfig.host, "-p", String(localDbConfig.port)],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findClusterProcessPid() {
  try {
    const output = execFileSync(
      "/usr/bin/pgrep",
      ["-f", `/usr/lib/postgresql/.*/bin/postgres -D ${dataDir}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();

    const [firstLine] = output.split("\n");
    if (!firstLine) {
      return null;
    }

    const pid = Number.parseInt(firstLine, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function readLocalDbConfig() {
  const databaseUrlRaw = process.env.DATABASE_URL;
  if (databaseUrlRaw) {
    try {
      const url = new URL(databaseUrlRaw);
      return {
        host: url.hostname || defaultHost,
        port: url.port ? Number.parseInt(url.port, 10) : defaultPort,
      };
    } catch {
      return { host: defaultHost, port: defaultPort };
    }
  }

  return { host: defaultHost, port: defaultPort };
}

function findExecutable(binaryName) {
  const searchPaths = [
    process.env.PG_BIN_DIR ? join(process.env.PG_BIN_DIR, binaryName) : null,
    process.env.POSTGRES_BIN && binaryName === "postgres" ? process.env.POSTGRES_BIN : null,
    "/usr/lib/postgresql/17/bin/" + binaryName,
    "/usr/lib/postgresql/16/bin/" + binaryName,
    "/usr/lib/postgresql/15/bin/" + binaryName,
    "/usr/lib/postgresql/14/bin/" + binaryName,
    "/usr/lib/postgresql/13/bin/" + binaryName,
  ].filter(Boolean);

  for (const candidate of searchPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  process.stderr.write(
    `Unable to locate '${binaryName}'. Set PG_BIN_DIR or POSTGRES_BIN if PostgreSQL is installed elsewhere.\n`,
  );
  process.exit(1);
}

function assertDataDirExists() {
  if (existsSync(dataDir)) {
    return;
  }

  process.stderr.write(`Local Postgres data directory not found: ${dataDir}\n`);
  process.exit(1);
}

function printUsage() {
  process.stdout.write(
    "Usage: node scripts/local-postgres.mjs <start|stop|restart|status>\n",
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryLoadEnvFile(path) {
  if (typeof process.loadEnvFile === "function" && existsSync(path)) {
    process.loadEnvFile(path);
  }
}
