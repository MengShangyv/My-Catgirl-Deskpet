# 猫娘桌宠（nya-pet）

一只趴在桌面右下角的 Q 版猫娘 Electron 桌宠：她实时监控本机 Codex CLI 的会话日志，用立绘和气泡向你汇报每一个 agent 正在做什么、进展如何、什么时候完工。

## 功能一览

- **实时监控 agent 工作进展**：监听 `~/.codex/sessions/年/月/日/rollout-*.jsonl`（chokidar），新文件 = 新会话，追加写入 = 进展更新。
- **每个会话解析出**：项目目录、工作状态、最新消息摘要、轮数、token 用量。
- **四状态猫娘立绘**：idle / working / done / error（AI 生成，可再生成）；图片缺失时自动回退到内置 CSS 简笔画猫娘，功能不受影响。
- **气泡轮播**：多个 agent 同时干活时，头顶气泡每 6 秒轮换汇报对象；没有活跃 agent 时偶尔卖萌。
- **详情面板**：单击猫娘打开"猫娘情报站"，列出所有 agent 的项目、状态、起止时间、轮数、tokens、最新消息。
- **任务完成通知**：agent 完成任务时弹出 Windows 原生通知"喵！任务完成了 nya~"。
- **桌面级体验**：无边框透明置顶窗口、可直接拖拽、双击开启鼠标点击穿透、系统托盘常驻（显示猫娘 / 打开详情 / 暂停监控 / 退出）。
- **内部子代理自动过滤**：guardian 安全审查等内部子代理（`source.subagent` / `thread_source=guardian_review`）不会被当作独立 agent 展示。

## 快速开始

### 前置要求

- Node.js 18+（建议 20 LTS）
- Windows 10 / 11（透明窗口在 Windows 下验证；其它平台理论可运行但未测试）
- 本机已使用过 Codex CLI，`~/.codex/sessions` 下存在会话日志

### 安装与运行

```bash
# 默认 npm 源在本机可能有 TLS 问题，推荐使用 npmmirror 镜像安装
npm install --registry=https://registry.npmmirror.com

# 若 electron 二进制下载失败，可额外指定镜像：
# set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   (CMD)
# export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ (Git Bash)

# 启动
npm start
```

启动后猫娘出现在屏幕右下角。跑一个 codex 任务（或最近 2 天内已有会话日志），她就会开始汇报。

### 运行测试

```bash
node scripts/test.mjs
```

## 猫娘状态说明

| 状态 | 触发条件 | 猫娘表现 |
|---|---|---|
| **working** | 最近 3 分钟内（`idleTimeoutMs` 可配）有新日志事件 | 专注干活立绘，气泡实时滚动该 agent 的最新进展 |
| **done** | 会话收到 `task_complete` 事件 | 开心举爪立绘，并弹系统通知"喵！任务完成了 nya~"（完成后若长时间无新事件，会随超时判定回落为 idle） |
| **idle** | 超过 `idleTimeoutMs` 没有任何新事件 | 打瞌睡摸鱼，气泡偶尔卖萌（"咦？大家都睡了…"） |

另有两种低频状态：

- **unknown**：刚发现会话、还没解析到任何事件（详情面板显示"待命"）。
- **error**：预留的异常态立绘，当前版本解析逻辑不会产生此状态。

猫娘整体心情取所有 agent 中优先级最高的状态（working > done > error > idle）；空闲 2 天以上的旧会话会被自动清理，不进入列表。

## 交互操作

| 操作 | 效果 |
|---|---|
| 单击猫娘（或气泡） | 打开详情面板"猫娘情报站" |
| 双击猫娘 | 切换鼠标点击穿透（开启后点击穿过猫娘落到下层窗口，猫娘不再挡操作） |
| 按住猫娘拖动 | 移动窗口位置（整个猫娘区域都是拖拽把手） |
| 托盘图标右键 | 菜单：显示猫娘 / 打开详情面板 / 开启（关闭）点击穿透 / 暂停（恢复）监控 / 退出 |
| 托盘图标双击 | 打开详情面板 |

详情面板中每个 agent 条目包含：agent 名（originator）、项目目录、状态徽章、完整 cwd、开始时间、最近活动时间、轮数、token 用量（k）、最新消息摘要。

## 配置说明

配置文件为 `~/.nya-pet/config.json`（Windows 下即 `C:\Users\<用户名>\.nya-pet\config.json`），**完全可选**——文件不存在时全部使用默认值。可复制仓库中的 `config.example.json` 为其改名使用：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sessionRoots` | string[] | `["<用户主目录>/.codex/sessions"]` | 要监控的日志根目录列表，递归监听其下所有 `*.jsonl` 文件。可添加其它 agent 的日志目录（如 Claude 的 `~/.claude/projects`，注意目前只内置 codex 日志的解析规则） |
| `idleTimeoutMs` | number | `180000`（3 分钟） | 超过该毫秒数没有任何新事件，agent 被判定为 idle |

修改配置后重启应用生效。

## 工作原理

### 目录结构

```
猫娘桌宠/
├── main.js                  # Electron 主进程：窗口、托盘、通知、IPC、启动监控
├── preload.js               # contextBridge 安全 IPC 桥
├── src/
│   ├── watcher.js           # chokidar 监听会话日志，聚合各 agent 状态
│   └── parser.js            # rollout JSONL → agent 状态模型
├── renderer/
│   ├── index.html           # 宠物窗口
│   ├── pet.css / pet.js     # 立绘切换、气泡轮播、点击/穿透/拖拽
│   └── detail.html          # 详情面板（猫娘情报站）
├── assets/cats/             # 四状态立绘 + 托盘图标（可再生成）
├── scripts/
│   ├── gen-assets.mjs       # AI 素材再生成脚本
│   └── test.mjs             # 测试脚本
├── config.example.json      # 配置示例（复制到 ~/.nya-pet/config.json）
└── package.json
```

### 数据流

```
   Codex CLI 会话日志
   ~/.codex/sessions/年/月/日/rollout-*.jsonl
                 │
                 │ chokidar 监听（新文件 = 新会话；追加写入 = 进展更新）
                 ▼
   ┌────────────────────────────────┐
   │ src/watcher.js   AgentWatcher  │
   │ · 启动时全量扫描（保留近 2 天）  │
   │ · 每 15 秒重算 idle / done     │
   └───────────────┬────────────────┘
                   │ 逐行 ingest
   ┌───────────────▼────────────────┐
   │ src/parser.js  SessionState    │
   │ · session_meta  → 注册 agent   │
   │ · event_msg     → 任务事件     │
   │ · response_item → 消息/工具    │
   └───────────────┬────────────────┘
                   │ agent 状态快照（数组）
   ┌───────────────▼────────────────────────────┐
   │ main.js（Electron 主进程）                   │
   │  宠物窗口 · 详情窗口 · 托盘 · 原生通知 · IPC  │
   └──────┬────────────────────────────┬────────┘
          │ preload.js (contextBridge) │ preload.js
          ▼                            ▼
   ┌──────────────┐             ┌──────────────┐
   │ 宠物窗口       │             │ 详情面板       │
   │ renderer/     │             │ renderer/     │
   │ index.html    │             │ detail.html   │
   │ pet.css/pet.js│             │ 猫娘情报站     │
   └──────┬───────┘             └──────────────┘
          │ 按状态切换
          ▼
   assets/cats/{idle,working,done,error}.png
   （缺失时回退内置 CSS 简笔画猫娘）
```

几个实现细节：

- **状态判定**：收到 `task_complete` → done；超过 `idleTimeoutMs` 无新事件 → idle；近期有事件 → working；尚无事件 → unknown。每 15 秒 tick 一次重算，因此超时判定最多有约 15 秒延迟。
- **增量解析**：日志文件是追加写入，watcher 只解析上次之后新增的行；写入稳定约 800ms 后才触发处理，避免读到半行。
- **摘要优先级**：最新 agent 消息 → 推理（reasoning）摘要 → 最近调用的工具名 → "正在思考…"。
- **排序**：agent 列表按 working > done > idle > unknown 排列，同状态按最近活动时间倒序。
- **完成通知**：agent 从非 done 变为 done（新完成）时触发一次原生通知，重复完成不重复弹。
- **暂停监控**：暂停的是 UI 广播与通知，后台日志监听仍在进行，恢复后立即接续。

## 素材再生成

猫娘立绘存放在 `assets/cats/`：

```
assets/cats/
├── idle.png      # 打瞌睡
├── working.png   # 专注干活
├── done.png      # 开心举爪
├── error.png     # 汗颜慌张
└── tray.png      # 托盘图标
```

重新生成：

```bash
node scripts/gen-assets.mjs          # 生成缺失的图片
node scripts/gen-assets.mjs --force  # 强制覆盖已存在的图片
```

素材不存在时不必担心：宠物窗口启动时会自动探测图片是否可用，缺失时回退到内置的 CSS 简笔画猫娘，所有功能照常可用。

## 已知限制

- **依赖 codex 日志格式**：解析逻辑针对 Codex CLI 的 rollout JSONL 格式编写，codex 版本升级导致日志结构变化时，`src/parser.js` 可能需要同步调整。
- **只内置 codex 解析规则**：`sessionRoots` 可以添加其它 agent 的日志目录（如 `~/.claude/projects`），但目前只有 codex 日志能被解析出有意义的状态。
- **Windows 透明窗口依赖系统合成器**：在远程桌面、部分虚拟机或关闭合成效果的环境下，透明窗口可能出现黑底/白底。
- **只统计最近 2 天**：启动扫描时 2 天内无事件的会话会被清理，不进入列表。
- **点击穿透恢复**：开启穿透后窗口不再响应鼠标事件（双击恢复随之失效），此时从托盘菜单选"关闭点击穿透"即可恢复。
