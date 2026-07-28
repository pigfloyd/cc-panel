# cc-panel

Claude Code / Codex CLI 多终端状态面板（Windows）。常驻副屏，把每个正在运行的 agent 会话显示为一张卡片，用颜色区分状态；点击卡片把对应的 Windows Terminal、PowerShell 或 cmd 窗口移到主屏并置前。

## 状态颜色

界面采用浅灰工作区（`#eef1f4`）和近黑文字。每种会话状态使用对应的浅色卡片背景，并通过状态标签辅助识别。

| 状态 | 卡片表现 | 状态主色 | 动效 / 含义 |
|---|---|---|---|
| 工作中 | 浅蓝背景与标签 | 蓝 `#2f6feb` | 圆点呼吸；agent 正在执行任务 |
| 等待输入 | 浅红背景与标签 | 红 `#c93850` | 等待权限确认或用户回复 |
| 已完成 | 浅绿背景与标签 | 绿 `#22835a` | 当前回合已完成 |
| 出错 | 浅琥珀背景与标签 | 琥珀 `#a86100` | 工具失败或停止失败 |
| 空闲 | 浅灰背景与标签 | 灰 `#687381` | 会话刚启动或可以继续输入 |

## 使用

```powershell
npm install
npm start
```

用于 README 或发布页截图时，可以启动完全隔离的假数据页面：

```powershell
npm run demo
```

Demo 模式不会启动本地 hook 服务、安装 hooks、读取真实会话或修改正式配置，可以和正式面板同时运行。

启动 cc-panel 后会自动安装 hooks：把 cc-panel 的 hook 条目追加到 Claude Code 的 `~/.claude/settings.json`（如果存在）以及 Codex CLI 的 `~/.codex/hooks.json`（保留已有的其他 hooks，首次写入前自动备份为 `*.cc-panel-bak`）。之后**新启动**的 `claude` / `codex` 会话会读取这些 hooks。面板每 5 秒自检一次，配置被其他程序覆盖后会自动补回缺失条目；也会按相同周期增量扫描进程，避免 hook 尚未生效时漏掉新终端。

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

- hook 缺失或尚未生效：进程扫描仍会创建卡片并映射窗口，但工作中、等待输入等实时状态仍依赖 hook 事件。
- claude / codex 跑在 VS Code / 其他未识别终端里：状态正常显示，但没有可聚焦窗口，卡片标"无窗口"。
- 手动把多个 agent 放在同一个 Windows Terminal 窗口的不同标签页时，Windows 只提供共享的顶层窗口句柄，卡片无法切换到指定标签页；请使用面板的新建终端按钮或分别打开独立窗口。
- 提交 prompt 后瞬间切走窗口（<300ms）可能抓错前台窗口——下次提交会自动纠正。

## 卸载

面板内目前无卸载按钮（M2），手动方式：删除 `~/.claude/settings.json` 和/或 `~/.codex/hooks.json` 中所有 command 含 `cc-panel-hook.js` 的条目，或用对应的 `*.cc-panel-bak` 备份还原。
