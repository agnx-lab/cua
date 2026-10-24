/**
 * 场景：Cua 子应用入口 —— 注册一个面板（cua.main）+ 一个命令（cua.open）。
 * 宿主走 exports.activate 或 exports.default.activate，两处都给。
 */
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";
import { buildPermissionDetailRows } from "@agnx-lab/app-sdk";
import { createElement } from "react";
import { Text } from "react-native";
import { CUA_APP_ID, CUA_OPEN_COMMAND_ID, CUA_PANEL_ID } from "./constants";
import { bindCuaHost, CuaPanel } from "./panel";

export const appId = CUA_APP_ID;

export function activate(host: WorkspaceAppHostApi): () => void {
  bindCuaHost(host);

  const disposers: Array<() => void> = [];

  // ① 面板（= 一类 Tab）：Cua Spaces Web 控制台，满铺贴边。
  disposers.push(
    host.registerMiniApp({
      id: CUA_PANEL_ID,
      appId: CUA_APP_ID,
      title: "Cua",
      component: CuaPanel,
      primaryPanel: true,
      // 上游 SPA 的纯单键快捷键（g 序列跳转等）需要宿主把按键投递进 iframe。
      iframeShortcutCapture: true,
    }),
  );

  // ② 权限做进「详情配置」：Tab 里正常显示应用，权限状态在详情里看与配置。
  // 授权对象是宿主 Agnx（macOS 里勾的是它，不是本应用名）。
  disposers.push(
    // 注意：registerDetailSheetExtras 挂在 host.ui 下，不是 host 顶层。
    host.ui.registerDetailSheetExtras({
      buildRows: buildPermissionDetailRows(host, {
        required: ["screen.capture", "accessibility"],
        // 已授权就显示「已授权」，不再给按钮；未授权给一个跳系统设置的入口。
        renderAction: ({ satisfied, openSettings }) =>
          satisfied
            ? createElement(Text, { style: { fontSize: 12 } }, "已授权")
            : createElement(
                Text,
                {
                  style: { fontSize: 12, textDecorationLine: "underline", cursor: "pointer" },
                  onPress: openSettings,
                },
                "去系统设置",
              ),
      }),
      surface: "config",
    }),
  );

  // ② 命令 → 打开 Tab（命令面板可搜）。
  disposers.push(
    host.registerCommand({
      id: CUA_OPEN_COMMAND_ID,
      appId: CUA_APP_ID,
      title: "Cua",
      keywords: ["cua", "computer-use", "spaces"],
      sidebarAction: { defaultVisible: true, label: "Cua", order: 67 },
      run: (context) => {
        host.openSubAppTab({
          appId: CUA_APP_ID,
          panelId: CUA_PANEL_ID,
          serverId: context?.serverId,
          workspaceId: context?.workspaceId,
          currentPathname: context?.currentPathname,
        });
      },
    }),
  );

  return () => {
    for (const d of disposers.toReversed()) d();
  };
}

const moduleExport: WorkspaceAppModule = { appId: CUA_APP_ID, activate };
export default moduleExport;
