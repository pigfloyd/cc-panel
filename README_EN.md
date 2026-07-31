# cc-panel

[中文](./README.md)

A multi-session status panel for Claude Code and Codex CLI on Windows. It brings AI coding sessions scattered across terminal windows into one view, so you can quickly see which sessions are running, waiting for input, complete, or interrupted, then click a card to return directly to its terminal window.

![cc-panel screenshot](./intro.png)

## Features

- Track Claude Code and Codex CLI sessions at the same time
- Show project directories, terminal processes, status duration, and recent activity
- Distinguish running, input-required, completed, error, and idle sessions
- Automatically stack idle sessions at the top; expand them on hover and collapse them again three seconds after the pointer leaves
- Focus the associated terminal window by clicking a session card
- Cycle through terminals by input-required, error, and completed priority with a global shortcut
- Minimize every associated terminal window with one command
- Start Claude Code or Codex CLI directly from a selected directory
- Keep recently used directories for quickly opening another session
- Detect native terminals such as Windows Terminal automatically, with support for specifying another EXE
- Configure always-on-top, status sounds, and launch at startup
- Install and verify Claude Code / Codex CLI hooks automatically

## Session States

| State | Visual treatment | Meaning |
| --- | --- | --- |
| Running | Blue glass light and label ripple | The agent is executing a task |
| Input required | Red glass light | Waiting for a permission decision or user reply |
| Completed | Green glass light | The current turn has finished |
| Error | Amber glass light | A tool failed or the session stopped unexpectedly |
| Idle | No light, pixel glass remains | The session is open and ready for more input |

## Requirements

- Windows 10 or Windows 11
- Node.js and npm
- At least one of Claude Code or Codex CLI installed and usable

## Run Locally

```powershell
npm install
npm start
```

The application installs required hooks when it starts. Run `claude` or `codex` in a terminal afterwards and the corresponding session will appear in the panel.

To inspect the interface and sample states only, launch demo mode:

```powershell
npm run demo
```

Demo mode does not start the local event service, install hooks, read real sessions, or change production configuration. It can run alongside the normal panel.

## Usage

- Click a session card to switch to its terminal.
- Click the `Claude Code` or `Codex CLI` button at the bottom, then choose a working directory, to create a session.
- Hover over a launch button to quickly start from a recently used directory.
- Click the settings button at the bottom to configure always-on-top, sounds, startup, and terminal applications.
- Press `Alt+X` to focus terminals in input-required, error, then completed priority; press it repeatedly to cycle through them.
- Click the minimize button at the bottom, or press `Alt+Z`, to minimize all detected terminal windows.

## Configuration and Hooks

Runtime data is stored in `~/.cc-panel/` in the user's home directory:

- `config.json`: window position and application settings
- `runtime.json`: local event service runtime information

The application receives hook events through a local loopback address, using ports `24333` through `24337` as candidates. At startup it updates these configurations:

- Claude Code: `~/.claude/settings.json`
- Codex CLI: `$CODEX_HOME/hooks.json`, or `~/.codex/hooks.json` when `CODEX_HOME` is not set

Before the first modification, the application creates a backup with the `.cc-panel-bak` suffix for each file and preserves other existing hooks in the configuration. The panel checks hooks and running sessions every five seconds, restoring a missing cc-panel hook automatically.

New hooks are read only by Claude Code / Codex CLI sessions started after installation. If Codex CLI reports that hooks are not trusted yet, run `/hooks` in Codex to review and trust the cc-panel hook. You may need to trust it again after its content changes.

## How It Works

```text
Claude Code / Codex CLI
        │ hooks
        ▼
hook/cc-panel-hook.js
        │ HTTP POST (local loopback only)
        ▼
cc-panel ──► session status cards ──► associated terminal window
```

Agent hooks provide most status information. The hook records the terminal window associated with a session and sends events to the panel. The panel also periodically scans local processes to supplement sessions that have not emitted a hook event yet. Clicking a card restores and focuses its window through the Windows API.

## Known Limitations

- When hooks are missing or have not been loaded by a new session, process scanning can still create cards, but real-time states such as running and input-required depend on hook events.
- Sessions run in VS Code or another unrecognized terminal can display their status, but their cards may be marked as having no window and cannot be focused.
- Multiple agents in different tabs of one Windows Terminal window share the same top-level window handle, so the panel cannot switch to a specific tab. Use the panel's bottom launch buttons to create independent windows.
- Switching windows immediately after submitting a prompt may make foreground-window detection inaccurate. The next submission refreshes the mapping.

## Removing Hooks

The interface does not currently provide an uninstall action. Remove cc-panel entries whose commands contain `cc-panel-hook.js` or `cc-panel-hook.cmd` from `~/.claude/settings.json` and `~/.codex/hooks.json`, or restore the corresponding `.cc-panel-bak` backup. Exiting or deleting the application does not remove these hooks automatically.

## Development

```powershell
# Run tests
npm test

# Start the development build
npm start

# Start with demo data
npm run demo
```

The project is built with Electron. Main-process code lives in `src/main/`, renderer code lives in `src/renderer/`, and shared event scripts for Claude Code / Codex CLI live in `hook/`.

## License

MIT
