# DeepSeek Harness Desktop

类似 Codex 桌面端的 DeepSeek Harness 桌面外壳：**内置完整 harness 源码本体**，
双击/一条命令启动，自动拉起 `dsh web` 并在原生窗口打开 Web GUI；同时监听官方
GitHub 仓库，有更新时弹窗提示，一键拉取重建并自动重启。全程不需要碰终端。

## 工作原理

- 应用自带 deepseek-harness 官方源码（`harness/`，git 浅克隆）。首次启动若缺失，
  会自动克隆官方仓库、`pnpm install`、`pnpm run build`，进度显示在启动画面。
- 启动时以子进程运行官方同款源码启动命令
  （`node --import tsx/esm apps/cli/src/bin.ts web --port 0`，端口系统自动分配），
  通过就绪信号 `dsh web: http://127.0.0.1:<port>` 探测完成并在窗口内加载。
- **自动更新**：启动 15 秒后及此后每 30 分钟，`git fetch` 官方仓库对比本地 HEAD。
  发现新提交时弹窗（显示提交数与版本），选择「更新并重启」后：关窗 → 停止服务 →
  `git merge --ff-only` → 重装依赖 → 重新构建 → 自动重启应用。选择「稍后」则该版本
  不再打扰，直到出现更新的提交。
- 安装/构建失败会自动清理就绪标记，下次启动重新引导，不会带着半成品上线。
- 关闭窗口即退出应用并优雅停止 dsh 子进程（SIGINT → SIGTERM → SIGKILL）。
- 启动日志：`~/Library/Application Support/DeepSeek Harness Desktop/logs/dsh.log`。

## 运行（开发模式）

```sh
npm install   # 首次：装 Electron（若 ~/.npm 缓存有 root 文件需先 sudo chown 修复）
npm start     # 每次启动：一条命令，其余全部自动
```

Node 要求：系统 `node >= 22.19`（dsh 的 engines 要求）。系统 node 缺失或过旧时，
应用自动改用 Electron 内置 Node。pnpm 由 corepack 按 harness 锁定的版本自动获取，
缓存全部收在工作区（`.corepack/`、`.pnpm-store/`），不污染全局。

API Key 等配置与命令行版完全一致：读取环境变量 / `.env` / `~/.dsh`，会话数据共享。

## 打包成 macOS 应用（后续阶段）

```sh
npm run dist:mac
```

打包前需把 `harness/`（源码 + 构建产物，排除 node_modules）纳入
`electron-builder.yml` 的 `files`，并处理沙箱外 pnpm/git 的运行时路径；产物输出
`dist/`。未签名构建首次打开需在「系统设置 → 隐私与安全性」允许。

## 项目结构

```
harness/            内置的 deepseek-harness 官方源码（应用自管：克隆/更新/构建）
src/main.mjs        Electron 主进程：窗口生命周期、启动/停止、更新调度与提示
src/server.mjs      dsh 子进程管理：Node 运行时选择、就绪探测、优雅退出
src/updater.mjs     harness 生命周期：克隆/安装/构建自检、官方仓库更新检查与应用
src/preload.cjs     contextBridge：给启动画面提供状态/退出能力
src/splash.html     启动画面（状态 + 失败日志 + 退出按钮）
test-server.mjs     dsh 启动冒烟测试（node test-server.mjs）
test-updater.mjs    更新管线演练（node test-updater.mjs）
```
