/**
 * 场景：Cua 子应用常量。appId / panelId / 端口 / ensure 路径的唯一出处。
 * 端口 8126 为批次台账独占分配（8100–8127 已核对，8126 空且不撞任何已装 app，8127 留给 ui-tars）。
 */
export const CUA_APP_ID = "cua";
export const CUA_PANEL_ID = "cua.main";
export const CUA_OPEN_COMMAND_ID = "cua.open";
export const CUA_ENSURE_TOOL_REL = ".agnx/tools/ensure-cua.mjs";
export const CUA_DEFAULT_PORT = 8126;
