const path = require("path");

function normalizeTerminalExecutable(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildLaunchSpec(terminalExecutable, cwd, terminalCommand) {
  const configuredExecutable = normalizeTerminalExecutable(terminalExecutable);
  const executable = configuredExecutable || "wt.exe";
  const executableName = path.win32.basename(executable).toLowerCase();

  switch (executableName) {
    case "pwsh.exe":
      return {
        executable,
        args: ["-NoLogo", "-NoExit", "-Command", terminalCommand],
        cwd,
      };
    case "powershell.exe":
      return {
        executable,
        args: ["-NoLogo", "-NoExit", "-Command", terminalCommand],
        cwd,
      };
    case "cmd.exe":
      return {
        executable,
        args: ["/d", "/k", terminalCommand],
        cwd,
      };
    case "wt.exe":
    case "windowsterminal.exe":
      return {
        executable,
        // npm-installed agent CLIs are commonly .cmd/.ps1 shims. Running the
        // command through cmd keeps Windows Terminal from treating the shim as
        // a native executable and falling back to an empty shell.
        args: ["new-tab", "-d", cwd, "cmd.exe", "/d", "/k", terminalCommand],
        cwd,
      };
    default:
      return { executable, args: [terminalCommand], cwd };
  }
}

module.exports = {
  normalizeTerminalExecutable,
  buildLaunchSpec,
};
