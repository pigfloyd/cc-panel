const fs = require("fs");
const path = require("path");

function firstExisting(candidates, fileExists) {
  for (const candidate of candidates) {
    if (candidate && fileExists(candidate)) return path.win32.normalize(candidate);
  }
  return null;
}

function executableOnPath(name, env, fileExists) {
  const pathValue = env.Path || env.PATH || "";
  const candidates = pathValue
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => path.win32.join(entry, name));
  return firstExisting(candidates, fileExists);
}

function detectTerminalApps(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return [];

  const env = options.env || process.env;
  const fileExists = options.fileExists || fs.existsSync;
  const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const localAppData = env.LOCALAPPDATA;

  const definitions = [
    {
      id: "windows-terminal",
      name: "Windows Terminal",
      candidates: [
        localAppData && path.win32.join(localAppData, "Microsoft", "WindowsApps", "wt.exe"),
        executableOnPath("wt.exe", env, fileExists),
      ],
    },
    {
      id: "powershell-7",
      name: "PowerShell 7",
      candidates: [
        executableOnPath("pwsh.exe", env, fileExists),
        path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
      ],
    },
    {
      id: "windows-powershell",
      name: "Windows PowerShell",
      candidates: [
        path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        executableOnPath("powershell.exe", env, fileExists),
      ],
    },
    {
      id: "command-prompt",
      name: "命令提示符",
      candidates: [
        env.ComSpec,
        path.win32.join(systemRoot, "System32", "cmd.exe"),
        executableOnPath("cmd.exe", env, fileExists),
      ],
    },
  ];

  const seen = new Set();
  const terminals = [];
  for (const definition of definitions) {
    const executable = firstExisting(definition.candidates, fileExists);
    if (!executable) continue;
    const key = executable.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terminals.push({
      id: definition.id,
      name: definition.name,
      executable,
    });
  }
  return terminals;
}

module.exports = { detectTerminalApps };
