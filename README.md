# dsh-wechat-kb

**微信知识库问答 + 项目知识复习**，一个 DSH 插件。

本包由两个独立插件合并而成，功能代码原样保留，只把两者的设置页合成了一页：

| 来源 | 版本 | 保留内容 |
| --- | --- | --- |
| `dsh-wechat-bridge` | 1.4.0 | 微信本地库收消息、UI 自动化发消息、`/dsh-wechat-bridge/*` 路由、`wechat_send`/`wechat_status` 工具、Python 桥接进程与 venv 管理、配置页「微信」部分 |
| `dsh-project-knowledge-review` | 0.5.14 | 本地知识库（导入文件 / 图片 OCR / 音频转写 / 检索 / 复习提示词）、`project_knowledge_*` 七个工具、`/api/project-knowledge-review/*` 路由、设置页「知识复习」部分 |

合并后只改了以下几处“胶水”：

1. 新包名与条目 id：`dsh-wechat-kb`。
2. 宿主入口 `lib/host.js` = 原微信 `apply` + 原知识库 `apply`；知识库代码整体放进 `lib/knowledge/`，内部相对导入不变。
3. 微信宿主原先按兄弟目录引用 `dsh-project-knowledge-review/lib/local-store.js`，现在指向包内 `lib/knowledge/local-store.js`。
4. 设置命名空间（= profile 条目 id）统一为 `dsh-wechat-kb`；HTTP 路由前缀、工具名、数据文件路径全部保持原样。
5. 网页半边只有一个 `window.__ModuleLoader__.load`，设置页一页两段：上面「微信」，下面「知识复习」。
6. 左侧栏原来的「知识库」入口改为「微信知识库」：点它直接打开设置面板并落在这一页；原来的「知识库」按钮挪到这一页右上角。

## 原始文档

- 微信桥接：`docs/wechat-bridge-README.md`、更新日志 `docs/wechat-bridge-CHANGELOG.md`
- 项目知识复习：`docs/project-knowledge-review-README.md`（截图在 `docs/images/`）

## 安装

作为 DSH bundle 安装（`dsh.bundle.patch` 指向 `cordis.patch.yml`），条目 id 为 `dsh-wechat-kb`。

## 许可

MIT。微信桥接部分 © Yuuyuko-uu / thawline；知识复习部分 © 其原作者。见 `LICENSE`。
