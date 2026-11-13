# 006 部署

这份文档覆盖在已有 Harness profile 上装好 `/polish`、确认它真的活着、以及出问题时先看哪。它建立在 [001 领域模型](001-domain.md) 到 [005 界面](005-interface.md) 之上。

插件没有独立进程、没有服务端账号、没有数据库。它是一个 bundle：宿主加载它，它注册一个命令和一条 HTTP 路由。

## 运行什么

| 组件 | 形态 | 说明 |
| --- | --- | --- |
| dsh web | 常驻进程 | 宿主。命令、路由、模型调用都由它承载 |
| `dsh-prompt-polish` | bundle | 装进 profile 的 `dsh.profile.bundles`。Host 半边在宿主进程里，Client 半边在浏览器里 |
| 浏览器 | 用户自己开 | 打开 Harness Web UI。插件的浮层与按钮都渲染在这里 |

没有需要单独启动的进程。

## 前置条件

| 项 | 值 |
| --- | --- |
| DSH | `0.2.2-rc.1` |
| Node | `>= 24.9.0`（DSH 自己的 `engines` 要求） |
| 包管理器 | pnpm（profile 目录是 pnpm workspace） |
| 语言与构建 | 普通 ESM JavaScript，无构建步骤。Client 半边由 DSH 的 client module loader 直接加载 |
| 依赖 | 零。`package.json` 没有 `dependencies`，也不声明对 `@deepseek-ai/dsh-*` 的依赖 |
| 仓库 | 根目录即 bundle 本体，`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml` |
| 模型 | 至少一个可用的 provider/model；带图片时需要该模型声明 `image` 输入 |

## 安装

在仓库根目录执行：

```bash
pnpm install                                   # 装 profile 依赖，`link:` 让插件指向本仓库
cd ~/.dsh/profiles/web && pnpm install         # 让 profile 看见新增的 bundle
```

然后用 `plugin_manager` 把仓库登记成 bundle：

```
plugin_manager action=install_bundle target=<仓库根绝对路径>
```

每行产生什么：

| 命令 | 产生什么 |
| --- | --- |
| 仓库根的 `pnpm install` | 生成 `node_modules` 链接；插件零依赖，这一步只建链接 |
| profile 目录的 `pnpm install` | 把 `dsh-prompt-polish` 链进 `~/.dsh/profiles/web/node_modules/` |
| `install_bundle` | 把本插件写进 profile 的 bundles 列表并装好 |

`install_bundle` 返回的 `application` 字段说明这次改动有没有真的落地，`warnings` 里列出没有生效的部分。日志与进程列表不反映加载结果。

## 配置

插件不声明任何配置键。`cordis.patch.yml` 只有一行：

```yaml
- insert:
    - id: polish
      name: 'dsh-prompt-polish'
```

| 键 | 是否必填 | 含义 |
| --- | --- | --- |
| `id` | 必填 | 固定 `polish`。关掉插件时按这个 id 定位 |
| `name` | 必填 | 固定 `dsh-prompt-polish`，必须与 `package.json` 的 `name` 一致 |

插件向宿主声明七个必需 Service。提供方在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 两个基础 bundle 里：

| Service | 提供方 | 用在哪 |
| --- | --- | --- |
| `commands` | `dsh-base` 的 `@deepseek-ai/dsh-commands` | 注册 `/polish` |
| `llm` | `dsh-base` 的 `@deepseek-ai/dsh-llm` | 调模型、查模型能力 |
| `agentDefaultModel` | `dsh-base` 的 `@deepseek-ai/dsh-agent-default-model` | 兜底路由 |
| `sessionQuery` | `dsh-base` 的 `@deepseek-ai/dsh-session-query-sqlite` | 只读上下文与会话记录的模型 |
| `attachments` | `dsh-base` 的 `@deepseek-ai/dsh-attachment-local` | 图片准入 |
| `connection` | `dsh-web-app` 的 `@deepseek-ai/dsh-client-connection` | 路由认证判定 |
| `webServer` | `dsh-web-app` 的 `@deepseek-ai/dsh-host-webserver` | 挂自有路由 |

少任何一个，宿主会在加载时报 inject 错误，插件不会进 `active`。

`agents` 不进声明列表，用 `ctx.get` 软取；没有 agent registry 的部署照样能加载。

## 启停与状态

`tmp/restart-dsh.sh` 未进仓库（`tmp/` 已 gitignore）。在新机器上照下面的内容建一份再执行：

```bash
#!/usr/bin/env bash
# Restart the running dsh web instance with the same DSH_HOME / DSH_PROFILE.
set -u
PID=$(pgrep -f "dsh web" | head -1)
if [ -n "$PID" ]; then kill "$PID" 2>/dev/null; sleep 2; fi
setsid nohup dsh web --no-open > "$PWD/tmp/dsh-web.log" 2>&1 &
for i in $(seq 1 40); do
  sleep 1
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/ 2>/dev/null)
  if [ "$CODE" = "401" ]; then echo "back after ${i}s"; exit 0; fi
done
echo "did not come back"; tail -30 "$PWD/tmp/dsh-web.log"; exit 1
```

写进 `tmp/restart-dsh.sh`，执行 `bash tmp/restart-dsh.sh`。正常时打印 `back after Ns`，退出码 `0`；打不开时打印 `did not come back` 并贴出日志尾部，退出码 `1`。

| 退出码 | 含义 |
| --- | --- |
| `0` | 服务已回来，`/` 返回 `401` |
| `1` | 40 秒内没回来。看日志尾部，通常是端口占用或某个 bundle 加载失败 |

判定插件活着看两处：

| 查什么 | 怎么查 | 正常值 |
| --- | --- | --- |
| 插件行 | `plugin_manager action=list_plugins` 找 `include:polish` | `fiberPhase: active` |
| 路由 | `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3080/polish/translate` | `401`——路由在，认证闸门生效 |

未注册路径作对照：`GET /polish/nope` 得 `404`，`POST /polish/nope` 得 `405`。两者不是同一个数，说明 fallback 对方法有自己的处理。

## 首次使用

装好之后按下面走一遍：

1. 打开 `http://127.0.0.1:3080`，进任意一个会话。
2. 看输入框工具条，模型选择器左侧应有一个四角星按钮。
3. 在输入框写一句粗糙请求，点这个按钮。输入框上方出现浮层，显示 `正在转写…`。
4. 若模型反问，逐题选选项或直接写，点「继续」。
5. 拿到成品后点「采用」，文字进输入框，浮层关闭。
6. 确认文字**没有**被自动发出去。

## 升级

1. 记下当前提交：`git rev-parse HEAD`。
2. 拉新版本，跑 `npm test`，全绿再往下。
3. `plugin_manager action=install_bundle target=<仓库根绝对路径>`。
4. 重启 dsh：`bash tmp/restart-dsh.sh`。Host 半边被 ESM 缓存，不重启不会换代码。
5. 浏览器硬刷新页面，Client 半边随之更新。
6. 复跑上面「首次使用」的六步。

回滚：`git checkout <旧提交>`，再走第 3 到第 5 步。

## 排障

| 现象 | 原因与修法 |
| --- | --- |
| `plugin_manager` 里没有 `include:polish` 这一行 | `install_bundle` 没成功，或 profile 的 `dsh.profile.bundles` 里没有它。重装并看返回的 `application` 字段 |
| `cannot get property "webServer" without inject` | 用 `ctx.connection.rpc.handle` 挂路由会撞这条。本插件用自有路由，出现它说明代码被改回了旧路径 |
| 改了 `index.js` 但行为没变 | Host 模块被 ESM 缓存。重启 dsh |
| 按钮不出现 | `conversation.input.right` 只在有会话且输入框已渲染时挂载。先开一个会话 |
| 浮层位置不对 | 挂错 slot。`conversation.input.dock` 在输入框上方，`conversation.composer.dock` 在下方 |
| `当前没有可用的模型，请先在输入框的模型选择器里选一个模型` | 会话没有 live Agent、日志里也没有模型记录、部署也没有默认。在模型选择器里选一个 |
| `当前模型（xxx）不支持图片输入，请换一个支持图片的模型，或先从输入框移除图片` | 会话当前模型没声明 `image` 输入。换视觉模型，或移除图片 |
| `有一张图片无法读取（可能已损坏或类型不受支持），请重新添加后再试` | 图片结构不可读：类型不在白名单、`data` 为空、或文件 0 字节 |
| `模型没有返回 JSON 对象` | 模型没按提示词输出 JSON。重试；持续出现就改系统提示词 |
| `超过 60 秒仍未返回` | 单次调用超时。重试，或确认上游模型是否可用 |
| `转写接口返回 HTTP 401` | 浏览器会话失效。刷新页面重新登录 |
| `请求体超过 65536 字节` | 文本加图片超过了本次额度。删掉部分图片或缩短文本 |
| `Unsupported or malformed image data.` | 附件准入服务拒绝了图片。换一张图 |

日志位置：`dsh web` 的进程输出；用 `tmp/restart-dsh.sh` 重启时另见 `tmp/dsh-web.log`。
