# DeepSeek Harness Desktop

类似 Codex 桌面端的 DeepSeek Harness 桌面外壳：**内置完整 harness 源码本体**，
一条命令启动，自动拉起 `dsh web` 并在原生窗口打开 Web GUI；桌面应用有**自己的版本号**，
监听**你自己的 GitHub Releases**，发现新版本时在界面设置图标的右侧出现一个
「更新 vX.Y.Z」按钮——**只有你点击它，才会执行更新并重启**，绝不打断正在进行的任务。

## 工作原理

### 启动

- 应用自带 deepseek-harness 官方源码（`harness/`，git 浅克隆）。首次启动若缺失，
  会自动克隆官方仓库、`pnpm install`、`pnpm run build`，进度显示在启动画面。
- 以子进程运行官方同款源码启动命令（`node --import tsx/esm apps/cli/src/bin.ts web --port 0`，
  端口系统自动分配），通过就绪信号 `dsh web: http://127.0.0.1:<port>` 探测完成并加载进窗口。
- **构建指纹**：应用记录当前构建对应的 harness commit（`.harness-state.json`）。
  每次启动对比，commit 变了（你发版时更新了内置 harness，或在 harness/ 里手动
  pull 了官方代码）就自动重新构建；若依赖安装标记（`node_modules/.modules.yaml`）
  缺失，会先重装依赖再构建。
- 关闭窗口即退出并优雅停止 dsh 子进程（SIGINT → SIGTERM → SIGKILL）。
- 启动日志：`~/Library/Application Support/DeepSeek Harness Desktop/logs/dsh.log`。

### 自更新（包更新：mac 的 dmg / win 的 exe）

- 本地版本 = `package.json` 的 `version`；远端版本 = 你 GitHub 仓库的最新 Release tag
  （[`update-config.json`](update-config.json) 里的 `repo`，形如 `your-name/dsh-desktop`）。
  **不是**监听官方 harness 仓库——官方 harness 只是被封装在应用里的依赖，随你的发版一起走。
- 启动 15 秒后及每 30 分钟检查一次。发现 `latest > version` 时，在 Web GUI
  设置图标的右侧注入一个「更新 vX.Y.Z」胶囊按钮（官方界面改动导致锚点找不到时，
  回退到窗口右下角），等待你点击，绝不打断任务。
- 点击后（**打包版**）：electron-updater 按平台下载 Release 里的安装包
  （macOS 取 dmg，Windows 取 exe/NSIS），下载进度显示在启动画面；下载完成才停止
  dsh 服务，随后 `quitAndInstall` 自动安装新包并重启应用。重启时若内置 harness
  的 commit 变了，按指纹自动重建。
- 点击后（**开发版** `npm start`）：没有已安装的包可替换，自动在浏览器打开
  Release 页面供手动下载。
- `update-config.json` 的 `repo` 留空时跳过检查（还没上 GitHub 之前的状态）。

## 运行（开发模式）

```sh
npm install   # 首次：装 Electron
npm start     # 每次启动：一条命令，其余全部自动
```

Node 要求：系统 `node >= 22.19`。系统 node 缺失或过旧时自动改用 Electron 内置 Node。
pnpm 由 corepack 按 harness 锁定的版本自动获取，缓存全收在工作区，不污染全局。

测试钩子：`DSH_DESKTOP_FORCE_UPDATE=1 npm start` 会跳过远端检查，直接注入
「更新 v9.9.9-test」按钮，用于验证按钮位置与样式。

API Key 等配置与命令行版完全一致：读取环境变量 / `.env` / `~/.dsh`，会话数据共享。

## 上 GitHub 后的打包与发版

1. 改 `package.json` 的 `repository` 为你的仓库地址（electron-builder 发布要用），
   并填写 [`update-config.json`](update-config.json) 的 `repo`。
2. 打包（macOS 上可出 mac 包；Windows 包建议在 Windows 或 CI 上构建）：
   ```sh
   npm run dist:mac    # 产出 dist/*.dmg + *.zip + latest*.yml
   npm run dist:win    # 产出 dist/*Setup.exe + latest.yml（建议 CI 构建）
   ```
   首次打包前先完成「首次打包前的待办」里的两项（内置 harness 打包 + 引导路径迁移），
   否则安装包会缺 harness，或运行时因只读目录引导失败。
3. 发布到 GitHub Release（electron-builder 会自动上传包和更新元数据）：
   ```sh
   GH_TOKEN=xxx npm run release    # 等价于 electron-builder --publish always
   ```
4. 用户端检测到新 tag 后，设置右侧出现更新按钮，点击即自动下载安装包、安装、重启。
5. 若要升级内置 harness：更新 `harness/` 到目标 commit（建议以 submodule 方式管理），
   随发版一起打包；用户更新后首次启动会自动重建。
6. 注意：未签名（或未公证）的 macOS 包，每次自动更新后可能需在「系统设置 → 隐私与
   安全性」里允许一次；正式分发建议 Apple Developer 证书签名 + 公证。

## 项目结构

```
harness/            内置的 deepseek-harness 官方源码（应用自管：克隆/构建/指纹重建）
src/main.mjs        Electron 主进程：窗口生命周期、dsh 启动/停止、更新检查、
                    按钮注入、更新包下载与安装（electron-updater）
src/server.mjs      dsh 子进程管理：Node 运行时选择、就绪探测、优雅退出
src/updater.mjs     harness 引导（克隆/安装/构建指纹）＋ 应用自更新检查
                    （GitHub Releases 抓取、版本对比）
src/preload.cjs     contextBridge：启动画面状态/退出、更新按钮点击桥接
src/splash.html     启动画面（状态 + 失败日志 + 退出按钮）
update-config.json  自更新源配置：{"repo": "your-name/dsh-desktop"}
.harness-state.json 构建指纹（记录当前构建对应的 harness commit，自动生成）
test-server.mjs     dsh 启动冒烟测试（node test-server.mjs）
test-updater.mjs    版本比较 + Releases 检查演练（node test-updater.mjs；
                    包安装流程只在打包版内由 electron-updater 执行）
```

## 首次打包前的待办（代码尚未覆盖）

`npm start` 开发模式目前完整可用；打包成 dmg/exe 之前，还差这几件事（第 3 项可选）：

1. **harness 纳入安装包**：`electron-builder.yml` 的 `files` 目前只有壳层
   （`src/**`、`package.json`、`update-config.json`），`harness/` 的打包项还处于
   注释状态。首次打包前需把 `harness/`（源码 + 构建产物，排除 `node_modules`）加入。
2. **引导路径迁移**：打包后的应用目录只读（asar），而当前 `ensureHarness` 的
   克隆/安装/构建都在应用目录内进行。发布前需把 harness 工作目录迁到
   `app.getPath('userData')` 下，指纹文件 `.harness-state.json` 一并迁移。
3. **图标（可选）**：放一张 `build/icon.icns`（mac）/ `build/icon.ico`（win）
   给应用换品牌图标。
