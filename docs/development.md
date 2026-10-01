# 开发

> 状态：环境与流程已定，代码待实现。

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
- 纯 Client 半边（`client.js`）改动，若 `pnpm run dev:web` 在同一 checkout 运行，会随 HMR 自动重载；否则需要刷新页面。Host 半边改动需要重新加载插件。

## 验证（规则 D3）

改完必须：

1. `install_bundle`；
2. 在**真实 GUI**（http://127.0.0.1:3080）上操作：确认按钮出现在模型选择器左侧、浮层出现在输入框正上方、「采用」后文字进输入框且**没有被自动发送**；
3. 深色与浅色主题各看一遍；
4. 控制台无 slot 挂载崩溃。

只跑通安装不算验证完成。

## 调试

- 浏览器控制台看 Client 半边报错。
- Host 半边报错看 `dsh web` 的进程输出。
- 临时脚本、日志、抓包一律放 `tmp/`（规则 D1）。

## 常见坑

| 现象 | 原因 |
| --- | --- |
| 按钮不出现 | `conversation.input.right` 只在有 session 时渲染 |
| 浮层位置不对 | 挂错了 slot：`conversation.composer.dock` 在输入框**下方**，`conversation.input.dock` 才在上方 |
| 「采用」后消息被发出 | 误调了 `inputActions.submit()` —— 只允许 `setDraft()` |
| 样式在深色下不可读 | 用了硬编码颜色而不是主题 token |
| 改动看不到 | Client 半边没 HMR，页面没刷新 |
