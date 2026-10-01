# 开发

> 状态：**已实现**。

## 环境

- DSH `0.2.0-rc.2`，本机安装于 `/nix/store/phlcm79hb1aym7w3xdspj5qrgz8g4qjg-dsh-0.2.0-rc.2/`。
- 本仓库根目录 `/home/LMQ/github/提示词` 即 bundle 包本体。
- 无构建步骤、无 `node_modules`、无包管理器安装：源码就是可加载的 ESM。

## 权威信息源（按顺序）

1. **运行时探查**：`cordis_inspect_list` → `cordis_inspect_query`。查 slot 树（`Slots.listSubTree`）、Service 契约（`Service.listService`）、Config schema（`Config.listConfigs`）、主题 token（`Theme.listTokens`）。
2. **官方模板与说明**：skill `cordis-plugin-development` 的 `references/` 与 `templates/`（尤其是 `references/ui-plugin.md`、`references/host-plugin.md`、`references/user-actions.md`）。
3. **源码**：DSH 安装目录下 `<package>/lib/index.js` 与 `lib/types/**/*.d.ts`（带 JSDoc），不是 `src/`。

不要凭记忆猜 API 名或 slot 名。

## 安装与生效

```
plugin_manager action=install_bundle target=/home/LMQ/github/提示词
```

- 改动影响当前 profile 的所有会话，并跨重启保留。
- 判断是否真的生效，看安装结果里的 `application` 与 `warnings` 字段；日志、进程列表、页面 boot payload 都不算数。
- 安装后用 `cordis_inspect_query` 确认新行存在（不需要审批）。
- 纯 Client 半边（`client.js`）改动**硬刷新页面**即可生效。`[待确认]` 「若 `pnpm run dev:web` 在同一 checkout 运行会随 HMR 自动重载」这一条本项目从未验证过（开发期间一直是硬刷新），不要当既成事实。Host 半边改动**必须重启 dsh**，见 [runbook.md](runbook.md) §Host 改动必须重启。

## 验证（规则 D3）

改完必须：

1. `install_bundle`；
2. 在**真实 GUI**（http://127.0.0.1:3080）上操作：确认按钮出现在模型选择器左侧、浮层出现在输入框正上方、「采用」后文字进输入框且**没有被自动发送**；
3. 深色与浅色主题各看一遍；
4. 控制台无 slot 挂载崩溃。

只跑通安装不算验证完成。

## 测试

```
npm test          # = node --test，自动发现 test/*.test.js
```

零依赖，用的是 Node 内置 `node:test`。改任何行为前后都跑一遍；行为改动必须补测试（规则 D4）。覆盖范围与已知缺口见 [testing.md](testing.md)。

## 排障

调试入口、常见坑、Host 改动的重启要求与重启前的探针，全部在 [runbook.md](runbook.md)。
