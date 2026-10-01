# AGENTS

`/polish` —— DSH 插件：把粗糙提示词转写成规范提示词，确认后写入输入框。

## 文档索引

改代码前先读对应文档；文档与代码冲突时以代码为准，并立刻修文档（见 D2）。

| 文档 | 何时读 |
| --- | --- |
| [docs/tech-stack.md](docs/tech-stack.md) | 改技术选型、加依赖、考虑换实现方式前 |
| [docs/architecture.md](docs/architecture.md) | 改模块划分、Host/Client 职责、调用桥、写入路径前 |
| [docs/data-model.md](docs/data-model.md) | 改浮层状态机、追问轮次、错误态前 |
| [docs/api.md](docs/api.md) | 改 `/polish` 命令契约、Config 配置项、输出契约前 |
| [docs/development.md](docs/development.md) | 搭环境、安装 bundle、构建、调试前 |
| [docs/testing.md](docs/testing.md) | 写测试、跑盲读测试前 |
| [docs/decisions.md](docs/decisions.md) | 追问「为什么这么设计」「为什么不用 X」前 |

## 规则

每条都可证伪。`enforcement` 标明靠什么保证：`代码强制`（不写就是错）/ `提示词`（靠遵循，无机械检查）。

| # | 规则 | enforcement |
| --- | --- | --- |
| D1 | 临时文件只放 `tmp/`，不污染仓库其他目录 | 提示词 |
| D2 | 改代码前判断本次改动是否让 `docs/*.md` 或本文件过时；过时文档比没有文档更坏；判断不了时在回答末尾列出「可能已过时」清单 | 提示词 |
| D3 | 插件代码改完必须 `install_bundle` 并在**真实 GUI** 上验证，不能只看安装结果的 `application` 字段或日志 | 提示词 |
| D4 | 行为改动必须补对应自动化测试，并跑通 `npm test`（Node 内置 `node:test`，零依赖）；盲读测试是人工验收，不进 CI | 提示词 |
| D5 | 不建占位文档/占位文件：写不出真实内容的类型不建文件 | 提示词 |
| D6 | 源码放仓库**根目录**（`package.json` / `cordis.patch.yml` / `index.js` / `client.js`），不建 `packages/` 子目录 | 提示词 |
| D7 | 每完成一个业务就 commit，不必等用户开口；以 dsh 身份提交：`git commit --author="dsh <dsh@local>" --no-gpg-sign -m "<类型>: <文案>"`，类型取 `feat`/`fix`/`chore`/`docs`/`refactor` | 提示词 |
