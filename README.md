# cc-panel

Claude Code / Codex CLI 多终端状态面板（Windows）。常驻副屏，把每个正在运行的 agent 会话显示为一张卡片，用颜色区分状态；点击卡片把对应的 Windows Terminal、PowerShell 或 cmd 窗口移到主屏并置前。

## 状态颜色

界面采用暖白底色（`#f7f5f2`）、暖白面板（`#fffdf9`）和深棕文字（`#2d2926`），工作中状态使用蓝色（`#2878c7`）。

| 状态 | 卡片背景 | 状态主色 | 动效 / 含义 |
|---|---|---|---|
| 工作中 | 淡蓝 `#d9ebf8` | 蓝 `#2878c7` | agent 正在执行任务 |
| 等待输入 | 暖白 `#fffdf9` | 红 `#dc1f45` | 边框和圆点脉冲；等待权限确认或用户回复 |
| 出错 | 暖白 `#fffdf9` | 琥珀 `#c67a00` | 工具失败或停止失败 |
| 空闲 | 暖白 `#fffdf9` | 灰蓝 `#79828f` | 会话刚启动或当前回合已结束，可以继续输入 |
| 已结束 | 暖白 `#fffdf9` | 灰 `#949ba5` | 会话正常退出，卡片半透明并在 15 秒后消失 |
| 进程已退出 | 暖白 `#fffdf9` | 深灰 `#7f8690` | agent 进程已不存在，卡片半透明 |

## 使用

```powershell
npm install
npm start
```

启动 cc-panel 后会自动安装 hooks：把 cc-panel 的 hook 条目追加到 Claude Code 的 `~/.claude/settings.json`（如果存在）以及 Codex CLI 的 `~/.codex/hooks.json`（保留已有的其他 hooks，首次写入前自动备份为 `*.cc-panel-bak`）。之后**新启动**的 `claude` / `codex` 会话会自动出现在面板上。

Codex CLI 的非托管 hooks 需要在 Codex 里信任：启动 `codex` 后按提示运行 `/hooks`，审核并信任 cc-panel hook。hook 内容更新后需要重新信任。

- 📌 窗口置顶开关
- 🔔 状态变化提示音开关（变绿/变红时响）
- 面板位置和大小自动记忆；首次启动停靠在副屏右侧

## 工作原理

```
claude / codex (终端窗口) ── hooks ──► hook/cc-panel-hook.js ── HTTP POST ──► 127.0.0.1:24333 (面板)
```

- **状态**主要来自 hooks：Claude Code 使用 SessionStart / UserPromptSubmit / PreToolUse / Stop / Notification / SessionEnd / StopFailure / PostToolUseFailure；Codex CLI 使用 SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / Stop。Ctrl+C 不一定触发 Stop，面板会增量检查当前 transcript 的中断记录并回到空闲。
- **会话→窗口映射**：hook 在 SessionStart / UserPromptSubmit 时刻（你刚在那个终端敲过键，它大概率是前台窗口）用一次 PowerShell 快照抓前台窗口 HWND，并校验窗口是 Windows Terminal 或经典 PowerShell/cmd 控制台。每次提交 prompt 自动刷新映射；通过面板新建的 agent 会使用独立 Windows Terminal 窗口，确保每张卡片对应唯一窗口。
- **点击置前**：koffi FFI 调 `SetWindowPos` + `SetForegroundWindow`，窗口移到主显示器工作区居中；最小化的窗口自动还原。
- 面板没在运行时，hook 100ms 超时静默失败，对 claude 无任何影响。

## 已知限制

- 面板启动**之前**就在跑的会话：卡片会在下一个 hook 事件到达时出现，但窗口映射要等你下一次提交 prompt 才建立（此前点击提示"无窗口"）。
- claude / codex 跑在 VS Code / 其他未识别终端里：状态正常显示，但没有可聚焦窗口，卡片标"无窗口"。
- 手动把多个 agent 放在同一个 Windows Terminal 窗口的不同标签页时，Windows 只提供共享的顶层窗口句柄，卡片无法切换到指定标签页；请使用面板的新建终端按钮或分别打开独立窗口。
- 提交 prompt 后瞬间切走窗口（<300ms）可能抓错前台窗口——下次提交会自动纠正。

## 卸载

面板内目前无卸载按钮（M2），手动方式：删除 `~/.claude/settings.json` 和/或 `~/.codex/hooks.json` 中所有 command 含 `cc-panel-hook.js` 的条目，或用对应的 `*.cc-panel-bak` 备份还原。
