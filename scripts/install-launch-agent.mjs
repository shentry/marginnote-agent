import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LAUNCH_AGENT_LABEL = "com.shentry.marginnote-agent";

async function preferredNodePath() {
  const candidates = [
    process.env.MN_AGENT_NODE_PATH,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    process.execPath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known Node.js location.
    }
  }
  return process.execPath;
}

function launchAgentPath(pathEnvironment, nodePath) {
  const entries = [
    path.dirname(nodePath),
    ...(pathEnvironment || "")
      .split(path.delimiter)
      .filter((entry) => entry && !entry.includes("/.codex/tmp/")),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(entries)].join(path.delimiter);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createLaunchAgentPlist({
  nodePath,
  supervisorPath,
  projectDir,
  stdoutPath,
  stderrPath,
  pathEnvironment,
}) {
  const environment = pathEnvironment
    ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEnvironment)}</string>
  </dict>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(supervisorPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>${environment}
</dict>
</plist>
`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function isLoaded(target) {
  try {
    await run("/bin/launchctl", ["print", target]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectDir = path.resolve(scriptDir, "..");
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const logsDir = path.join(os.homedir(), "Library", "Logs", "MarginNote Agent");
  const plistPath = path.join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`);
  const supervisorPath = path.join(scriptDir, "marginnote-host-supervisor.mjs");
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const nodePath = await preferredNodePath();

  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    plistPath,
    createLaunchAgentPlist({
      nodePath,
      supervisorPath,
      projectDir,
      stdoutPath: path.join(logsDir, "launchd.out.log"),
      stderrPath: path.join(logsDir, "launchd.err.log"),
      pathEnvironment: launchAgentPath(process.env.PATH, nodePath),
    }),
    { mode: 0o644 },
  );
  await chmod(plistPath, 0o644);

  if (await isLoaded(target)) {
    await run("/bin/launchctl", ["bootout", target]);
    await delay(500);
  }
  await run("/bin/launchctl", ["bootstrap", domain, plistPath]);

  console.log(`Installed ${LAUNCH_AGENT_LABEL}.`);
  console.log(`Host now follows MarginNote 4: ${plistPath}`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  void main();
}
