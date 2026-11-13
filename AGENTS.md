# AGENTS

`/polish` —— DSH 插件：把粗糙提示词转写成规范提示词，确认后写入输入框。

## 文档索引

改代码前先读对应文档；文档与代码冲突时以代码为准，并立刻修文档（见 D2）。按编号顺序读，每份只建立在它前面几份之上。

| 文档 | 类型 | 何时读 |
| --- | --- | --- |
| [docs/000-philosophy.md](docs/000-philosophy.md) | 原则 | 判断一个功能能不能做，或要否决一个设计前 |
| [docs/001-domain.md](docs/001-domain.md) | 领域模型 | 确认概念怎么命名、状态与错误码有哪些取值前 |
| [docs/002-rules.md](docs/002-rules.md) | 规则与权限 | 改认证、准入、额度、上限、只读约束前 |
| [docs/003-lifecycle.md](docs/003-lifecycle.md) | 生命周期 | 改浮层状态机、迁移、重试、中止前 |
| [docs/004-prompts.md](docs/004-prompts.md) | 配置与提示词 | 改转写提示词、用户轮拼装、浮层文案前 |
| [docs/005-interface.md](docs/005-interface.md) | 界面 | 改浮层的显示内容、按钮、样式前 |
| [docs/006-deployment.md](docs/006-deployment.md) | 部署 | 搭环境、安装 bundle、判断是否真的生效、排障前 |
| [docs/007-architecture.md](docs/007-architecture.md) | 架构 | 改模块划分、Host/Client 职责、调用桥、写入路径、测试前 |
| [docs/008-manual.md](docs/008-manual.md) | 手册 | 加错误码、加图片类型、加浮层状态、换模型来源前 |
| [docs/decisions.md](docs/decisions.md) | 决策 | 追问「为什么这么设计」「为什么不用 X」前 |

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
| D8 | 文档与代码注释里不写本机绝对路径（`/home/…`、`/storage/…`、`/Users/…`、`C:\…`）与宿主安装路径（`/nix/store/…`、`node_modules/…` 的真实位置），一律用仓库相对路径；这类路径换台机器就失效，且暴露本机目录结构 | 提示词 |
