const fs = require("fs");
const path = require("path");

const VSCODE_PROCESS_NAMES = new Set([
  "code.exe",
  "code - insiders.exe",
]);

function directoryKey(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = path.win32.normalize(value.trim());
  const root = path.win32.parse(normalized).root;
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, "")
    : normalized;
  return withoutTrailingSeparators.toLowerCase();
}

function isVSCodeProcess(process) {
  return VSCODE_PROCESS_NAMES.has(String(process && process.name || "").toLowerCase());
}

function titleContainsProject(title, project) {
  const normalizedTitle = String(title || "").trim().toLowerCase();
  const normalizedProject = String(project || "").trim().toLowerCase();
  if (!normalizedTitle || !normalizedProject) return false;
  if (!/visual studio code(?: - insiders)?(?: \[administrator\])?$/.test(normalizedTitle)) {
    return false;
  }
  return normalizedTitle.startsWith(`${normalizedProject} - `) ||
    normalizedTitle.includes(` - ${normalizedProject} - `);
}

function findOpenDirectories(sessions, systemSnapshot) {
  if (!systemSnapshot) return new Set();
  const processes = Array.isArray(systemSnapshot.processes) ? systemSnapshot.processes : [];
  const windows = Array.isArray(systemSnapshot.windows) ? systemSnapshot.windows : [];
  const vscodePids = new Set(
    processes.filter(isVSCodeProcess).map((process) => Number(process.pid)),
  );
  const titles = windows
    .filter((window) => vscodePids.has(Number(window.pid)))
    .map((window) => window.title)
    .filter(Boolean);

  const openDirectories = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const key = directoryKey(session && session.cwd);
    if (!key) continue;
    const project = path.win32.basename(path.win32.normalize(session.cwd));
    if (titles.some((title) => titleContainsProject(title, project))) {
      openDirectories.add(key);
    }
  }
  return openDirectories;
}

function resolveVSCodeExecutable(environment = process.env, existsSync = fs.existsSync) {
  const candidates = [];
  if (environment.LOCALAPPDATA) {
    candidates.push(
      path.win32.join(environment.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
      path.win32.join(environment.LOCALAPPDATA, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"),
    );
  }
  for (const programFiles of [environment.ProgramFiles, environment["ProgramFiles(x86)"]]) {
    if (!programFiles) continue;
    candidates.push(
      path.win32.join(programFiles, "Microsoft VS Code", "Code.exe"),
      path.win32.join(programFiles, "Microsoft VS Code Insiders", "Code - Insiders.exe"),
    );
  }

  const pathDirectories = String(environment.Path || environment.PATH || "")
    .split(path.win32.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const directory of pathDirectories) {
    candidates.push(
      path.win32.join(directory, "Code.exe"),
      path.win32.resolve(directory, "..", "Code.exe"),
      path.win32.join(directory, "code.cmd"),
    );
  }

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function buildVSCodeLaunchSpec(directory, options = {}) {
  const environment = options.environment || process.env;
  const executable = options.executable || resolveVSCodeExecutable(
    environment,
    options.existsSync || fs.existsSync,
  );
  if (!executable) return null;

  if (/\.(?:cmd|bat)$/i.test(executable)) {
    const command = `"${executable}" --new-window "${directory}"`;
    return {
      executable: environment.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      cwd: directory,
    };
  }

  return {
    executable,
    args: ["--new-window", directory],
    cwd: directory,
  };
}

module.exports = {
  buildVSCodeLaunchSpec,
  directoryKey,
  findOpenDirectories,
  isVSCodeProcess,
  resolveVSCodeExecutable,
  titleContainsProject,
};
