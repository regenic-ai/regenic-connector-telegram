import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVISION = "4c6377aa7386c39217878a9a56d581922ad37ca4";
const ARCHIVE_SHA256 =
  "472015605fffa826bfba6ccf7d888905b436ecce94c8a6826203792edfbe5731";
const ARCHIVE_URL = `https://github.com/tdlib/td/archive/${REVISION}.tar.gz`;
const localCmake = join(ROOT, ".local", "build-tools", "cmake", "data", "bin", "cmake");
const cmakeCommand = (await exists(localCmake)) ? localCmake : "cmake";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The verified TDLib build currently supports macOS arm64 only");
}

await requireCommand(cmakeCommand, ["--version"]);
await requireCommand("gperf", ["--version"]);

const downloadDirectory = join(ROOT, ".local", "downloads");
const outputDirectory = join(ROOT, ".local", "tdlib");
const archivePath = join(downloadDirectory, `td-${REVISION}.tar.gz`);
await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

let archive = await readFileIfPresent(archivePath);
if (!archive || sha256(archive) !== ARCHIVE_SHA256) {
  const downloadTemp = join(
    downloadDirectory,
    `.td-${REVISION}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await run("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "20",
      "--max-time",
      "300",
      "--retry",
      "2",
      "--output",
      downloadTemp,
      ARCHIVE_URL,
    ]);
    archive = await readFile(downloadTemp);
    if (sha256(archive) !== ARCHIVE_SHA256) {
      throw new Error("Pinned TDLib source archive failed SHA-256 verification");
    }
    await rename(downloadTemp, archivePath);
    await chmod(archivePath, 0o600);
  } finally {
    await rm(downloadTemp, { force: true });
  }
}

const buildRoot = await mkdtemp(join(tmpdir(), `regenic-tdlib-${REVISION.slice(0, 8)}-`));
const sourcePath = join(buildRoot, "source");
const buildPath = join(buildRoot, "build");
await mkdir(sourcePath, { recursive: true });

try {
  const archiveTemp = join(buildRoot, "source.tar.gz");
  await copyFile(archivePath, archiveTemp);
  await run("tar", ["-xzf", archiveTemp, "-C", sourcePath, "--strip-components=1"]);
  const cmakeArgs = [
    "-S",
    sourcePath,
    "-B",
    buildPath,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_INSTALL_PREFIX=${join(buildRoot, "install")}`,
  ];
  const opensslRoot =
    process.env.OPENSSL_ROOT_DIR ??
    (await exists("/opt/homebrew/opt/openssl@3")
      ? "/opt/homebrew/opt/openssl@3"
      : undefined);
  if (opensslRoot) {
    cmakeArgs.push(`-DOPENSSL_ROOT_DIR=${opensslRoot}`);
  }
  await run(cmakeCommand, cmakeArgs);
  await run(cmakeCommand, [
    "--build",
    buildPath,
    "--target",
    "tdjson",
    "--parallel",
    String(Math.max(1, cpus().length - 1)),
  ]);
  const libraryPath = await findLibrary(buildPath);
  if (!libraryPath) {
    throw new Error("TDLib build completed without producing a libtdjson dylib");
  }
  const destination = join(outputDirectory, "libtdjson.dylib");
  await copyFile(libraryPath, destination);
  await chmodFile(destination);
  process.stdout.write(
    `Built TDLib ${libraryVersion(libraryPath)} from ${REVISION} (${ARCHIVE_SHA256}).\n`,
  );
  process.stdout.write(`Library: ${destination}\n`);
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

async function requireCommand(command, args) {
  try {
    await run(command, args, { quiet: true });
  } catch {
    throw new Error(`Required build tool "${command}" was not found or failed`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: options.quiet ? "ignore" : "inherit",
      env: process.env,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} exited with status ${code}`));
      }
    });
  });
}

async function readFileIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findLibrary(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findLibrary(path);
      if (nested) {
        return nested;
      }
    } else if (entry.name.startsWith("libtdjson") && entry.name.endsWith(".dylib")) {
      return path;
    }
  }
  return undefined;
}

async function chmodFile(path) {
  await chmod(path, 0o600);
}

function libraryVersion(path) {
  const match = /libtdjson(?:\.|[-_])(\d+\.\d+\.\d+)/.exec(path);
  return match?.[1] ?? "pinned snapshot";
}
