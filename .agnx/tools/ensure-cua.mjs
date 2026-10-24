#!/usr/bin/env node
/**
 * 场景：Agnx 子应用 cua 的受管 sidecar 启动脚本 —— 只起上游的 Web 控制台（Cua Spaces Web UI）。
 * 用法：node .agnx/tools/ensure-cua.mjs --port 8126 --work-dir <dataRoot> [--supervised]
 * 输出（stdout 最后一行 JSON）：
 *   - 已就绪复用：{"ok":true,"reused":true,"origin":"http://127.0.0.1:8126","pid":N}
 *   - 需拉起：    {"ok":false,...} 或 {"ok":true,"reused":false,"plan":{command,args,cwd,env,fingerprint,healthUrl,port}}
 *
 * 安全边界（本项目的特殊风险，写在最前面）：
 *   上游 Cua 是 Computer-Use 底座，能真实驱动鼠标键盘 / 截屏 / 起 VM。本脚本**只**起
 *   `apps/cua-spaces-web` 这个纯前端控制台（Vite 静态站点）。它不起 cua daemon、
 *   不起 cua-driver、不起 Lume/VM、不起 Docker、不建任何真机会话，
 *   因此**不会接管本机真实桌面**。
 *
 * 上游改动清单（全部是启动参数 / 构建参数，不改上游业务代码）：
 *   1. 构建：`vite build`（不跑 `pnpm build`，后者会先编 Rust→wasm 核心；缺 wasm 时上游
 *      自带 TypeScript fallback，见 apps/cua-spaces-web/src/bridge/README.md「The core」）。
 *   2. 起服：`vite preview --port 8126 --strictPort --host 127.0.0.1`（上游 preview 默认端口 5174，
 *      这里由 --port 覆盖；不写 vite.mock.config.ts，不复制第二份前端）。
 *   3. 环境：BROWSER=/usr/bin/true + PATH 前置假 `open` 压掉任何自动弹浏览器的行为。
 *   4. 数据：HOME / XDG_* 重定向到 --work-dir，落在 $AGNX_HOME/apps/data/cua/。
 *
 * 首次成本：`pnpm install --ignore-workspace`（约 1.5 分钟）+ `vite build`（约 25 秒）。
 *   ensure 只在 dist/ 缺失时做一次构建；之后启动是秒级。
 */
import { spawn } from "node:child_process";
import { access, constants as fsConstants, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const APP_ID = "cua";
const STATE_FILE = "cua.json";
const DEFAULT_PORT = 8126;
/** 上游 Web 控制台（Cua Spaces web UI），仓库内相对路径。 */
const WEB_REL = path.join("apps", "cua-spaces-web");

function parseArgs(argv) {
  const out = {
    port: Number(process.env.CUA_PORT ?? DEFAULT_PORT),
    workDir: process.env.AGNX_APP_DATA_ROOT || "",
    supervised: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.port = n;
      i += 1;
    } else if ((arg === "--work-dir" || arg === "--workDir") && next) {
      out.workDir = String(next).trim();
      i += 1;
    } else if (arg === "--supervised") {
      out.supervised = true;
    }
  }
  return out;
}

async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readState(workDir) {
  try {
    return JSON.parse(await readFile(path.join(workDir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

function healthOnce(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      // preview 对 "/" 直接给 index.html（200）；给了 2xx/3xx 就算活着。
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthOnce(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * 构建环境：HOME/XDG 指向数据根；BROWSER 与假 `open` 压掉自动弹浏览器；
 * CI=1 让上游脚本不尝试交互；npm_config_* 关掉 audit/fund 噪声。
 */
function buildEnv(workDir) {
  const home = path.join(workDir, "home");
  const fakeBin = path.join(home, ".agnx-fakebin");
  const basePath = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    // 上游任何"启动成功后开浏览器"的路径都打到空气里。
    BROWSER: "/usr/bin/true",
    PATH: `${fakeBin}:${basePath}`,
    CI: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
}

/** 写一个假的 `open`（macOS 专有的"打开地址"命令）+ `xdg-open`，防上游偷偷弹系统浏览器。 */
async function ensureFakeBrowserBin(env) {
  const fakeBin = env.PATH.split(":")[0];
  await mkdir(fakeBin, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    const p = path.join(fakeBin, name);
    if (!(await exists(p))) {
      await writeFile(p, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(p, 0o755);
    }
  }
}

function run(command, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => {
      out += String(b);
    });
    child.stderr.on("data", (b) => {
      out += String(b);
    });
    child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/**
 * 首次准备：依赖缺失才 `pnpm install`；产物缺失才 `vite build`。
 * 两者都写进日志文件（绝不用 pipe 常驻），沿用上游自带的语法。
 */
async function ensureBuilt(webDir, env, logFile) {
  const hasDist = await exists(path.join(webDir, "dist", "index.html"));
  if (hasDist) return true;

  const nodeModules = path.join(webDir, "node_modules", "vite", "package.json");
  const logs = [];
  if (!(await exists(nodeModules))) {
    const inst = await run("pnpm", ["install", "--ignore-workspace", "--reporter=append-only"], {
      cwd: webDir,
      env: { ...process.env, ...env },
    });
    logs.push(`install exit=${inst.code}`);
    if (inst.code !== 0) {
      await writeFile(logFile, inst.out, "utf8").catch(() => undefined);
      console.error(`ENSURE_INSTALL_FAILED: pnpm install 退出码 ${inst.code}（日志：${logFile}）`);
      return false;
    }
  }
  const build = await run(
    process.execPath,
    [path.join(webDir, "node_modules", "vite", "bin", "vite.js"), "build"],
    { cwd: webDir, env: { ...process.env, ...env } },
  );
  logs.push(`build exit=${build.code}`);
  await writeFile(logFile, `${logs.join("\n")}\n${build.out}`, "utf8").catch(() => undefined);
  if (build.code !== 0) {
    console.error(`ENSURE_BUILD_FAILED: vite build 退出码 ${build.code}（日志：${logFile}）`);
    return false;
  }
  return true;
}

function fingerprintOf(port, workDir) {
  return createHash("sha256").update(`${APP_ID}:${port}:${workDir}`).digest("hex").slice(0, 16);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port;
  const origin = `http://127.0.0.1:${port}`;
  const healthUrl = `${origin}/`;

  if (!args.workDir) {
    console.error("ENSURE_MISSING_DATA_ROOT: 需要 --work-dir 或 AGNX_APP_DATA_ROOT");
    process.exit(2);
  }
  const workDir = path.resolve(args.workDir);
  await mkdir(workDir, { recursive: true });

  const webDir = path.join(repoRoot, WEB_REL);
  if (!(await exists(path.join(webDir, "package.json")))) {
    console.error(`ENSURE_UPSTREAM_MISSING: ${webDir}`);
    process.exit(3);
  }

  // 1) 端口已就绪 → 复用（避免重复 spawn 撞端口）
  if (await healthOnce(port)) {
    const state = await readState(workDir);
    console.log(JSON.stringify({ ok: true, reused: true, origin, pid: state?.pid ?? null, port }));
    return;
  }

  const env = buildEnv(workDir);
  await ensureFakeBrowserBin(env);
  const fingerprint = fingerprintOf(port, workDir);
  const runtimeDir = path.join(repoRoot, ".agnx-runtime");
  await mkdir(runtimeDir, { recursive: true });
  const buildLog = path.join(runtimeDir, `${APP_ID}-build.log`);
  const runLog = path.join(runtimeDir, `${APP_ID}.log`);

  if (!(await ensureBuilt(webDir, env, buildLog))) {
    process.exit(4);
  }

  const viteBin = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
  if (!(await exists(viteBin))) {
    console.error(`ENSURE_VITE_MISSING: ${viteBin}`);
    process.exit(5);
  }
  const viteArgs = [
    viteBin,
    "preview",
    "--port",
    String(port),
    "--strictPort",
    "--host",
    "127.0.0.1",
  ];

  if (args.supervised) {
    // 只输出 plan，交给 daemon supervisor 拉起（它负责 pid / 日志 / 退出清理）
    console.log(
      JSON.stringify({
        ok: true,
        reused: false,
        plan: {
          command: process.execPath,
          args: viteArgs,
          cwd: webDir,
          env,
          fingerprint,
          healthUrl,
          port,
          logFile: runLog,
        },
      }),
    );
    return;
  }

  // 2) 短跑模式：自己 spawn（stdio 重定向到日志文件，绝不用 pipe）
  const out = await import("node:fs").then((m) => m.openSync(runLog, "a"));
  const child = spawn(process.execPath, viteArgs, {
    cwd: webDir,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  if (!(await waitForHealth(port, 120_000))) {
    console.error(`ENSURE_HEALTH_TIMEOUT: ${healthUrl}（日志：${runLog}）`);
    process.exit(6);
  }
  await writeFile(
    path.join(workDir, STATE_FILE),
    JSON.stringify({ appId: APP_ID, port, pid: child.pid, fingerprint, logFile: runLog }, null, 2),
    "utf8",
  );
  console.log(JSON.stringify({ ok: true, reused: false, origin, pid: child.pid, port }));
}

main().catch((err) => {
  console.error(`ENSURE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
