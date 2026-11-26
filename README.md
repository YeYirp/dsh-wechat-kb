# dsh-wechat-kb · 微信知识库问答

**微信知识库问答**，一个 DSH 插件：把「微信桥接」和「本地知识库」合在一页里 —— 在 DSH 里收发微信消息，同时把导入的文件（Word / Excel / PDF / 图片 / 音频）变成可检索、可引用的本地知识库。

> 这不是从零写的插件。它是把两个现成插件**原样合并**出来的，代码不是我们的，详见下面的「来源与致谢」。合并只动了「接线」和界面，两边功能逻辑一行没改。

---

## 来源与致谢

| 来源插件 | 版本 | 作者 / 仓库 | 本包保留的内容 |
| --- | --- | --- | --- |
| `dsh-wechat-bridge` | 1.4.0 | Yuuyuko-uu / [thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge) | 微信本地库收消息、UI 自动化发消息、`/dsh-wechat-bridge/*` 路由、`wechat_send` / `wechat_status` 工具、Python 桥接进程与运行环境管理（含它的自带运行环境下载与 pip 回退逻辑）、「微信」设置段 |
| `dsh-project-knowledge-review` | 0.5.14 | 原作者（见 `docs/project-knowledge-review-README.md`） | 本地知识库：导入、图片 OCR、音频转写、检索、复习提示词；`project_knowledge_*` 七个工具；`/api/project-knowledge-review/*` 路由；「知识复习」设置段 |

两边的 README 原文都放在 `docs/` 里（`docs/wechat-bridge-README.md`、`docs/project-knowledge-review-README.md`），更新日志 `docs/wechat-bridge-CHANGELOG.md`，截图 `docs/images/`。**上游文档仍然是这两个功能最准确的说明书**，本 README 只讲合并后哪里不一样。

许可：MIT（见 `LICENSE`）。微信桥接部分 © Yuuyuko-uu / thawline；知识复习部分 © 其原作者。本仓库只是把两者装进同一个包，不对原功能主张著作权。

---

## 合并改了什么

只有下面这些「胶水」，功能实现没有改写：

1. **包名与条目 id**：统一为 `dsh-wechat-kb`（设置命名空间、profile 条目 id、前端 bundle id 三者一致）。
2. **宿主入口**：`lib/host.js` = 原微信 `apply`（改名 `applyWechat`）+ 原知识库 `apply`；知识库代码整体搬进 `lib/knowledge/`，其内部相对导入保持原样。
3. **交叉引用**：原微信用兄弟目录找 `dsh-project-knowledge-review/lib/local-store.js`，现在指向包内 `lib/knowledge/local-store.js`。
4. **设置页合并**：前端只有一个 `window.__ModuleLoader__.load`（id `dsh-wechat-kb`），设置里只有一页「微信知识库问答」，上半「微信」、下半「知识复习」。
5. **左侧栏入口互换**：原来知识库的「知识库」按钮改成「微信知识库问答」，点了直接打开设置面板并落在这一页；原来那个「知识库」按钮挪到这一页右上角，点它打开知识库覆盖视图。
6. **数据目录**：知识库数据默认落在 `$DSH_HOME/project-knowledge-review/knowledge.json`（即 `D:\DSH\.dsh\project-knowledge-review\`），不再是用户主目录下的 `~/.dsh`。
7. **OCR 默认开启**：默认走本机网关 `http://127.0.0.1:8326/v1` + `deepseek-official/deepseek-flash`（DeepSeek-V4.1-Flash），密钥从环境变量 `DSH_KNOWLEDGE_OCR_API_KEY` 读，这三项都能在设置里改。
8. **图片 OCR 过滤放宽**：原来「宽 < 120 或高 < 80」的图整张跳过（长条截图因此识别不了），改成只跳过又小又矮的装饰图；OCR 拒识话术（「未识别到文字」之类）不再写进正文。
9. **导入提速**：PDF 抽图 OCR 改为 4 路并发 + 同图去重，9 页 46 图的 PDF 从约 870 秒降到约 400 秒；失败会重试一次。
10. **「装依赖」按上游改**：优先下载上游 Release 的预装运行环境（60 秒无进展就放弃），失败回退 venv + pip，默认源失败自动改走清华镜像。
11. **默认屏蔽**：新增「文件传输助手」等 7 个默认不回的会话。
12. **入站默认拒绝（fail-closed）**：`入站白名单` 为空时不再「谁都能发进来」，而是一条都不转进 DSH；要放行得在设置里显式填 wxid / 群名 / 昵称（显式绑定过的聊天与主人视同已同意）。
13. **改名**：界面与清单里的「通到微信」统一改为「微信知识库问答」，版本重置为 `1.0.0`。

> 第 6–11 条是合并之后在这个仓库里做的改动，不是上游行为。想要纯上游功能，请直接用上面表格里的两个仓库。

---

## 安装

作为 DSH bundle 安装（`dsh.bundle.patch` → `cordis.patch.yml`，条目 id `dsh-wechat-kb`）。

```bash
# 从本仓库（git）
dsh plugin install git+https://github.com/YeYirp/dsh-wechat-kb.git

# 或者本地 tgz
npm pack
dsh plugin install ./dsh-wechat-kb-1.0.0.tgz
```

没有发布到 npm registry；插件市场里需要以「自定义目录」的方式加入（见下）。

### 在插件市场里找到它

本仓库自带一份市场目录和对应安装包：

- `plugins.json` —— 目录条目（name / owner / url / category / description / install）
- `tarballs/dsh-wechat-kb-1.0.0.tgz` —— 与目录条目同源的安装包

在插件市场的「目录 / Catalogs」里添加自定义目录，选择本仓库的 `plugins.json`（或本地路径 `D:\DSH\.dsh\plugin-artifacts\market\plugins.json`），刷新后即可在「发现」里搜到「微信知识库问答」。

---

## 仓库

<https://github.com/YeYirp/dsh-wechat-kb>
