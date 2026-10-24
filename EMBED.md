# Cua · Agnx 子应用接入记录

> 上游：https://github.com/trycua/cua —— **30.2k★ · MIT（仓库根 `LICENSE.md`）**
> commit：`c2b20141b5607cab1b39ffaac4416d9978901da3`（main，2026-10-19T20:38:28Z，“fix(cua-driver): let the client wait out the largest tool budget”）
> 注意许可证分布：仓库根默认 **MIT**；`apps/cua-spaces*`、`libs/cua-spacesd`、`cua-keyvault`、`cua-teleport`、`cua-volume` 等目录自带 **FSL-1.1-MIT**（source-available，两年后转 MIT）。本子应用嵌的 `apps/cua-spaces-web` 属 FSL-1.1-MIT 目录。

## 一、上游原生能力与本次承接范围

- 上游原生平台：桌面 ✅｜网页 ✅｜移动 ❌
  （依据：`apps/cua-spaces-macos`（SwiftUI）、`apps/cua-spaces-desktop`（Electron）、`apps/cua-spaces-web`（Vite SPA，Electron 与 SwiftUI 宿主共用同一份 Web UI）、`apps/cua-spaces`（Tauri）；发布物里没有原生 iOS/Android 宿主的说明。
- **本子应用承接的是上游的 Web 控制台界面（Cua Spaces web UI）**，不是它的执行面。
- Cua 本体（Cua Driver / Lume VM / cua-spacesd / Sandbox SDK）需要 cua daemon、本地虚拟机或容器才能跑起来；
  本项目**明确不起**这些执行面（用户硬约束：不跑 Docker、不启虚拟机、不接管真实桌面）。

## 二、上游嵌入

- **工作方式**：原样嵌入（首选）+ 极薄胶水。上游前端代码零改动，只叠启动参数 / 构建参数。
- **Web 控制台入口**：`apps/cua-spaces-web/`（"Cua Spaces web UI"）。
  - 上游 README：`pnpm dev` → Vite 5174；`pnpm build` → 编 Rust→wasm 核心 + `dist/`。
  - 无宿主时上游自己进 **browser demo 模式**（`<html data-bridge="demo">`，内存态数据，
    见 `src/bridge/README.md`「The core」与 `e2e/host.ts`）。因此**不需要任何后端 / Docker / daemon** 就能出完整界面。
  - wasm 核心缺失时上游自带 TypeScript fallback（`src/bridge/derive.ts`），界面照常渲染。
- **起服方式**：`.agnx/tools/ensure-cua.mjs`（`sidecar.supervised=true`，daemon 托管）
  ```
  node node_modules/vite/bin/vite.js preview --port 8126 --strictPort --host 127.0.0.1
  cwd = $AGNX_HOME/apps/cua/apps/cua-spaces-web
  ```
  首次自动 `pnpm install --ignore-workspace` + `vite build`（只在 `dist/` 缺失时做一次）。
- **端口**：**8126**（批次台账独占分配；已核对 `lsof` 空、不撞任何已装 app 的 `sidecar.defaultPort`，8127 留给 ui-tars）。
- **挂载**：`guest.kind="web"` / `auth="none"` / `preferStrategy="auto"` → 桌面端 **direct-iframe**。
  实测：iframe `src = http://127.0.0.1:8126`，无障碍加载，**未出现 Origin 403 / frame-ancestors 拒载**（上游是纯静态 SPA，无 Origin 校验中间件）。
- **上游改动清单**：
  | 类别 | 内容 | 为什么必要 |
  | --- | --- | --- |
  | 构建参数 | 只跑 `vite build`，不跑 `pnpm build`（后者先编 Rust→wasm） | 避免装 Rust + wasm32 target + wasm-bindgen；上游自带 TS fallback |
  | 启动参数 | `vite preview --port 8126 --strictPort --host 127.0.0.1` | 上游 preview 硬编码 5174，且 5174 不在分配端口内 |
  | 环境变量 | `BROWSER=/usr/bin/true`，并把假 `open` / `xdg-open`（`exit 0`）前置进 PATH | 防上游/工具链启动成功后自动弹系统浏览器（vibe-kanban 已实测此法） |
  | 环境变量 | `HOME` / `XDG_{DATA,CONFIG,CACHE}_HOME` → `$AGNX_HOME/apps/data/cua/home` | 数据落 `apps/data/cua/`，不污染真实 home |
  | 源码改动 | **无**（`git diff` 为空，未改任何上游文件） | —— |
- **数据根**：`$AGNX_HOME/apps/data/cua/`（`cua.json` 状态 + `home/` 缓存）。
- **面板与 Tab**：
  | panelId | 名字 | 路径 |
  | --- | --- | --- |
  | `cua.main` | Cua | `ensureTool` → `.agnx/tools/ensure-cua.mjs` |
  命令 `cua.open`（title=`Cua`，侧栏按钮 label=`Cua`）。
- **图标**：`.agnx/assets/icon.svg`（上游 `apps/cua-spaces-web/public/cua_logo_black_new.svg`）、
  `.agnx/assets/icon-dark.svg`（同目录 `cua_logo_white_new.svg`），5.0KB / 5.2KB，均 <64KB。

## 三、安全边界（本项目的特殊风险）

**没有让 Cua 接管过真实桌面。** 具体隔离点：

1. 只起 `apps/cua-spaces-web` 这个静态 SPA，页面跑在上游自带的 **browser demo 宿主**（内存数据）；
   不起 cua daemon、不起 `cua-driver`、不起 Lume/VM、不起 Docker/compose，**没有拉起任何 CUA 会话**。
2. 页面上的 "New Space" 只改了前端内存列表（截图里出现一张 `Creating…` 卡片），
   不会落任何虚拟机，也不会截屏/移动真实鼠标键盘。
3. 未点击任何 "connect your screen / 连接本机屏幕" 一类入口。
4. 端口只用 `curl -I` 与桌面端 Tab 内操作探活，**没有用外部浏览器打开 8126**。

## 四、首次成本

- `pnpm install --ignore-workspace`：约 **1m36s**（第一次）。
- `vite build`：约 **24s**。
- 二开（`dist/` 已存在）：**秒级**（复用 `reused:true`）。
- 首次启动（install + build + 起 preview）实测 **约 2 分钟**，之后首次打开秒级。

## 五、桌面验收截图

- `logs/cua-desktop-initial-<ts>.png` —— 初始态：Agnx 侧栏 + Tab 条（`Cua` 高亮）+ Cua Spaces 主界面（Spaces 列表、This Mac / Mac mini 资源卡、三个 Running 沙箱）。
- `logs/cua-desktop-action-<ts>.png` —— 真实操作后：在 Tab 内点 **+ New Space**，列表增至 7 Spaces，首卡 `New Space / Creating…`。
- 红屏门闩 `npm run runtime-devtools -- gate error` → 退出码 0，快照为空。

## 六、嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 (A–E) | 主路径 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 真机/沙箱执行面（cua daemon、cua-driver、Lume VM、Sandbox SDK） | 上游 `cua sb create`、Cua Spaces 的 Start/Open Space、cua-spacesd :3211 | **本子应用不提供**：界面点 Start 只会改 demo 内存态 | E（如实记缺口，不伪造） | 仅 Web 控制台界面 | **⚠️ 部分交付**：要真正跑沙箱需 Docker/QEMU 或 macOS VM，按用户硬约束一律不起 |
| Docker / QEMU / VNC | 上游 `libs/qemu-docker`、`libs/lumen`、`docker/` 系脚本 | 会拉几十 GB 镜像 | E | 不启用 | 用户明确禁止 |
| 本机屏幕接管（截屏 / 鼠标键盘注入） | Cua Driver 的 macOS Accessibility / Screen Recording 权限 | 会打断真实桌面 | E | 不启用 | 需系统授权，且用户在验收 |
| 自动弹系统浏览器 | 上游/工具链启动后的 open-browser 路径 | 弹出独立窗口 = 违反「Tab 内看到主界面」 | A（已处置） | `BROWSER=/usr/bin/true` + 假 `open`/`xdg-open` 前置 | 已写进 ensure |
| 长按/右键等自定义手势 | 上游 SPA | iframe 内正常 | A | —— | 无需特殊 allow |
| 纯单键快捷键 | 上游全局键位 | 无面板 `iframeShortcutCapture` 时投递不到 | A（已处置） | 面板已开 `iframeShortcutCapture: true` | 带 Cmd 的组合键仍归宿主壳层 |
| 系统对话框 / 通知 / 托盘 | 上游 Settings 里的菜单栏、通知项 | iframe 内拿不到 | E | 忽略 | demo 宿主下本就不生效 |
| 深链 `cua://add/<code>` | 上游 `machines?join=` | iframe 内无法注册协议 | E | 忽略 | demo 宿主下标配对码不可用 |
