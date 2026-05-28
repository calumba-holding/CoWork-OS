#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "release");
const SERVER_DEPENDENCY_EXCLUDES = new Set(["@electron/rebuild"]);
const REQUIRED_PATHS = [
  "bin/coworkd-node.js",
  "bin/coworkctl.js",
  "dist/daemon/daemon/main.js",
  "deploy/systemd/cowork-os-node.service",
  "deploy/systemd/cowork-os.env.example",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }

  return result;
}

function electronInstallEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  env.npm_config_platform = "linux";
  env.npm_config_arch = "x64";
  return env;
}

async function exists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(fromRelative, toRoot) {
  const from = path.join(ROOT, fromRelative);
  if (!(await exists(from))) return false;
  await fsp.cp(from, path.join(toRoot, fromRelative), {
    recursive: true,
    force: true,
    dereference: false,
  });
  return true;
}

function getConnectorPackageNames(pkg) {
  const buildConnectorsScript = pkg.scripts?.["build:connectors"];
  if (typeof buildConnectorsScript !== "string" || buildConnectorsScript.length === 0) {
    throw new Error("Missing package.json scripts.build:connectors; cannot derive server connector package list.");
  }

  const names = new Set();
  const connectorPattern = /connectors\/([^/\s"']+)\/tsconfig\.json/g;
  for (const match of buildConnectorsScript.matchAll(connectorPattern)) {
    names.add(match[1]);
  }

  if (names.size === 0) {
    throw new Error("Could not derive connector package list from package.json scripts.build:connectors.");
  }

  return [...names].sort();
}

async function copyConnectorRuntimeFiles(toRoot, connectorPackageNames) {
  const connectorsRoot = path.join(ROOT, "connectors");
  if (!(await exists(connectorsRoot))) {
    throw new Error("Missing connectors directory. Run npm run build:connectors first.");
  }

  const missing = [];
  for (const connectorName of connectorPackageNames) {
    const connectorRoot = path.join(connectorsRoot, connectorName);
    const packageJsonPath = path.join(connectorRoot, "package.json");
    const distIndexPath = path.join(connectorRoot, "dist", "index.js");

    if (!(await exists(packageJsonPath))) {
      missing.push(`${connectorName}/package.json`);
    }
    if (!(await exists(distIndexPath))) {
      missing.push(`${connectorName}/dist/index.js`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required connector runtime files:\n${missing
        .map((item) => `  - connectors/${item}`)
        .join("\n")}\nRun npm run build:connectors first.`
    );
  }

  for (const connectorName of connectorPackageNames) {
    const connectorRoot = path.join(connectorsRoot, connectorName);
    const targetRoot = path.join(toRoot, "connectors", connectorName);
    for (const name of ["dist", "README.md", "package.json"]) {
      const source = path.join(connectorRoot, name);
      if (await exists(source)) {
        await fsp.cp(source, path.join(targetRoot, name), {
          recursive: true,
          force: true,
          dereference: false,
        });
      }
    }
  }
}

function prunePackageJsonForServer(pkg) {
  const serverPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    homepage: pkg.homepage,
    repository: pkg.repository,
    bugs: pkg.bugs,
    overrides: pkg.overrides,
    bundleDependencies: pkg.bundleDependencies,
    main: "dist/daemon/daemon/main.js",
    bin: {
      coworkctl: "bin/coworkctl.js",
      "coworkd-node": "bin/coworkd-node.js",
    },
    engines: pkg.engines,
    dependencies: {},
    optionalDependencies: pkg.optionalDependencies ?? {},
  };

  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!SERVER_DEPENDENCY_EXCLUDES.has(name)) {
      serverPkg.dependencies[name] = version;
    }
  }

  return serverPkg;
}

async function assertElectronBinaryInstalled(packageRoot) {
  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  const electronPath = packageRequire("electron");
  if (typeof electronPath !== "string" || electronPath.length === 0) {
    throw new Error("Expected require('electron') to resolve to an Electron binary path.");
  }

  const stat = await fsp.stat(electronPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Electron binary was not installed at ${electronPath}.`);
  }
}

async function ensureElectronBinaryInstalled(packageRoot) {
  const electronDir = path.join(packageRoot, "node_modules", "electron");
  const pathTxt = path.join(electronDir, "path.txt");

  run(process.execPath, ["node_modules/electron/install.js"], {
    cwd: packageRoot,
    env: electronInstallEnv(),
  });

  if (await exists(pathTxt)) {
    return;
  }

  console.log("[linux-server-package] electron/install.js did not create path.txt; downloading Linux x64 Electron manually.");

  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  const { downloadArtifact } = packageRequire("@electron/get");
  const extract = packageRequire("extract-zip");
  const electronPkg = packageRequire(path.join(electronDir, "package.json"));
  const checksums = packageRequire(path.join(electronDir, "checksums.json"));
  const distDir = path.join(electronDir, "dist");

  const zipPath = await downloadArtifact({
    version: electronPkg.version,
    artifactName: "electron",
    platform: "linux",
    arch: "x64",
    checksums,
  });

  await fsp.rm(distDir, { recursive: true, force: true });
  await fsp.mkdir(distDir, { recursive: true });
  await extract(zipPath, { dir: distDir });
  await fsp.writeFile(pathTxt, "electron");
}

async function writeInstallNotes(packageRoot, version) {
  const content = `# CoWork OS Linux Server Package

Version: ${version}

This package runs the Node-only headless daemon. It does not launch the desktop UI or require Xvfb.

Quick start:

\`\`\`bash
export COWORK_USER_DATA_DIR=/var/lib/cowork-os
export COWORK_IMPORT_ENV_SETTINGS=1
export OPENAI_API_KEY=your_key_here
node bin/coworkd-node.js --print-control-plane-token
\`\`\`

For an always-on service, use:

- deploy/systemd/cowork-os-node.service
- deploy/systemd/cowork-os.env.example

See docs/vps-linux.md and docs/self-hosting.md for full setup, SSH tunnel, and Control Plane instructions.
`;

  await fsp.writeFile(path.join(packageRoot, "INSTALL.md"), content);
}

async function assertRequiredBuildOutputs() {
  const missing = [];
  for (const relativePath of REQUIRED_PATHS) {
    if (!(await exists(path.join(ROOT, relativePath)))) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required files for Linux server package:\n${missing
        .map((item) => `  - ${item}`)
        .join("\n")}\nRun npm run build:daemon && npm run build:connectors first.`
    );
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux server packages must be built on linux x64 so native modules match the target.");
  }

  await assertRequiredBuildOutputs();

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.version;
  const connectorPackageNames = getConnectorPackageNames(pkg);
  const packageName = `cowork-os-server-linux-x64-v${version}`;
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "cowork-linux-server-package-"));
  const packageRoot = path.join(tempRoot, packageName);

  try {
    await fsp.mkdir(packageRoot, { recursive: true });

    await fsp.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(prunePackageJsonForServer(pkg), null, 2)}\n`
    );
    await copyIfPresent("package-lock.json", packageRoot);

    for (const relativePath of ["README.md", "CHANGELOG.md", "LICENSE"]) {
      await copyIfPresent(relativePath, packageRoot);
    }

    for (const relativePath of [
      "bin/coworkd-node.js",
      "bin/coworkctl.js",
      "dist/daemon",
      "deploy/systemd",
      "resources",
      "docs/vps-linux.md",
      "docs/self-hosting.md",
      "docs/node-daemon.md",
      "docs/remote-access.md",
    ]) {
      await copyIfPresent(relativePath, packageRoot);
    }

    await copyConnectorRuntimeFiles(packageRoot, connectorPackageNames);
    await writeInstallNotes(packageRoot, version);

    await fsp.chmod(path.join(packageRoot, "bin", "coworkd-node.js"), 0o755);
    await fsp.chmod(path.join(packageRoot, "bin", "coworkctl.js"), 0o755);

    run("npm", ["install", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: packageRoot,
    });
    await ensureElectronBinaryInstalled(packageRoot);
    await assertElectronBinaryInstalled(packageRoot);
    run("npm", ["rebuild", "--ignore-scripts=false", "better-sqlite3"], { cwd: packageRoot });

    await fsp.mkdir(RELEASE_DIR, { recursive: true });
    const tarballPath = path.join(RELEASE_DIR, `${packageName}.tar.gz`);
    const checksumPath = `${tarballPath}.sha256`;

    await fsp.rm(tarballPath, { force: true });
    await fsp.rm(checksumPath, { force: true });

    run("tar", ["-czf", tarballPath, "-C", tempRoot, packageName]);

    const checksum = await sha256File(tarballPath);
    await fsp.writeFile(checksumPath, `${checksum}  ${path.basename(tarballPath)}\n`);

    console.log(`[linux-server-package] Wrote ${tarballPath}`);
    console.log(`[linux-server-package] Wrote ${checksumPath}`);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[linux-server-package] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
