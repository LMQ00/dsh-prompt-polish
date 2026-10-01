# 排障

> 状态：**已实现**。这里只放「出问题时看什么」。环境、安装与生效判定见 [development.md](development.md)。

## 常见坑

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 按钮不出现 | `conversation.input.right` 只在**有 session 且有 input** 时渲染（shipped 代码里是 `input === undefined \|\| sessionId === undefined ? null : renderSlot(...)`） | 先建/开一个会话 |
| 浮层位置不对 | 挂错 slot：`conversation.composer.dock` 在输入框**下方**，`conversation.input.dock` 才在上方 | 用 `conversation.input.dock` |
| 「采用」后消息被发出 | 误调了 `inputActions.submit()` | 只允许 `setDraft()`；测试里有源码级断言禁止 `.submit(` |
| 样式在深色下不可读 | 用了硬编码颜色而不是主题 token | 用 `--dsw-*` / `--dsh-*` 变量，见 `Theme.listTokens` |
| 按钮闪烁 / 悬停态看起来粘住 | 样式表被当成 React 元素渲染：render 阶段的 `document.querySelector` 守卫在「有→无→有」之间翻转，输入框每敲一个字都重渲染按钮，整套样式被反复摘掉挂回 | **命令式注入一次**（`apply` 里 `document.createElement('style')` + `ctx.effect` 回收），不要用 React 元素 |
| 面板里的输入框打不进字 | 用 effect 重置表单草稿会和击键竞争，把输入吞掉 | 改成 render 阶段比较签名再重置（React 官方的「prop 变了就调整 state」写法） |
| 浮层在**空白新会话**里被压扁（旧会话正常） | 新会话的 composer 是 hero 变体：`composerStack` 是列向 flex 且高度受限，`conversation.input.dock` 子元素默认 `flex-shrink: 1` | 给面板加 `flex: 0 0 auto` |
| 改了 `index.js` 但行为没变 | Host 模块被 ESM 缓存，见下 | 重启 dsh |

## Host 改动必须重启

`index.js` 在进程生命周期内被 ESM 缓存：`plugin_manager install_bundle`、`set_plugin` 关开一次、`remove_bundle` + 重装，**三条路都只会复用旧模块**（实测：报错栈里的行号仍是旧文件的行号）。`client.js` 不受此限，硬刷新页面即可。

重启脚本：`bash tmp/restart-dsh.sh`（kill 当前 dsh → 以同样的 `DSH_HOME`/`DSH_PROFILE` 用 `setsid nohup dsh web --no-open` 重启 → 轮询 3080 直到服务回来）。

**重启前先探针**，避免把 GUI 打死后才发现命令有问题：

```bash
# 隔离的 DSH_HOME（复制配置 + 软链 node_modules），换端口起一次，不碰正在用的实例
mkdir -p tmp/probe-home/profiles/web
cp ~/.dsh/profiles/web/package.json ~/.dsh/profiles/web/cordis.yml ~/.dsh/profiles/web/cordis.patch.yml tmp/probe-home/profiles/web/
ln -sfn ~/.dsh/profiles/web/node_modules tmp/probe-home/profiles/web/node_modules
DSH_HOME=$PWD/tmp/probe-home timeout 40 dsh web --port 3099 --no-open > tmp/probe.log 2>&1 &
sleep 14 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3099/
```

`401` = 服务起来了（认证闸门生效）。**已知探针噪声**：日志里会出现 `better-sidebar (dsh-better-sidebar): failed to import`——那是软链 `node_modules` 改变了它自己的解析路径所致，与 `polish` 无关；真实实例里它正常。

## 调试入口

| 要确认的事 | 怎么看 |
| --- | --- |
| Client 半边报错 | 浏览器控制台（F12） |
| Host 半边报错 | `dsh web` 的进程输出；重启后另见 `~/.dsh/web-restart.log` |
| 插件是否真的活着 | `plugin_manager action=list_plugins` 找 `include:polish`，看 `fiberPhase` 是否为 `active` |
| 路由是否真的挂上 | `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3080/polish/translate` → `401` 表示路由在且认证闸门生效；未注册路径 `GET` 得 `404`、`POST` 得 `405`（**不是 404**）。完整判据见 [api.md](api.md) §HTTP 契约 |
| 运行时契约 | `cordis_inspect_query`（slot 树 / Service 契约 / Config / 主题 token） |

临时脚本、日志、抓包一律放 `tmp/`（规则 D1）。
