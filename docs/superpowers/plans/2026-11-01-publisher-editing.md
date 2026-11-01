# Publisher Editing Implementation Plan

> Execute independent tasks with superpowers:subagent-driven-development; integrate and verify in this session.

**Goal:** 实现用户确认的图片排版、可选博客稿与独立窗口预览并安装验证。
**Architecture:** 在现有 ItemView 与 worker 上增量实现；共享图片清单用于 UI 与转换；原笔记/博客稿选择在快照入口统一处理；窗口仅展示现有预览服务。
**Tech Stack:** CommonJS、Obsidian API、Astro、CSS、node:test。
**Spec:** ../specs/2026-11-01-publisher-editing.md

## Global Constraints
- 原文与原附件不受图片排版操作影响；博客稿附件共用。
- 旧记录/网址兼容，不自动创建博客稿；禁止新增文章与导入入口。
- 错误与旧版本不能放行发布。没有实际窗口时服务核验作为完成信号，窗口打开后再核验显示版本。
- 不发送文章到外部测试服务，不使用用户文章实际发布来测试。

## Review Focus
- 同图多处与代码块内伪图片；百分比、像素和图注转义。
- 博客稿移动后附件引用、源文变化、外部编辑冲突、缺失稿件与误关联。
- 多次窗口开关、切换记录、旧窗口消息、关闭清理与跨 document 元素。
- Windows 附件路径、文件名冲突、无效图像与粘贴时光标。
- 数据导入验证与操作期间并发修改。

### Task 1: 图片清单与转换（独立代理）
- [x] 红→绿测试：每处图片不同设置、代码不解析、转义、边界、指纹变化。
- [x] 共享 image-layout.cjs 提供 listImages(markdown)、normalizeLayout(value)；convert.mjs 消费 snapshot.imageLayouts。
- [x] 更新博客图片 CSS，只对显式排版生效；保留旧图默认行为。

### Task 2: 博客稿与快照（独立代理）
- [x] 红→绿测试：可选创建、重开、独立保存、共享附件、同身份、外部修改保护。
- [x] model/main 增加 contentMode、draftPath；snapshot 返回所选正文及 imageLayouts；实现稿件编辑与附件插入 API。

### Task 3: 工作台与窗口（主代理）
- [x] 替换内嵌网页为阶段状态；独立预览 View 通过 workspace.openPopoutLeaf 创建。
- [x] 原笔记图片设置、可选稿件编辑与来源标记、VS Code 入口、粘贴拖入。
- [x] 调整行为测试覆盖新发布校验与窗口刷新，保留原有调度防护。

### Task 4: 验证交付
- [x] 全套发布器测试、格式、插件构建、网页构建；独立代码审查。
- [x] 安装插件程序包，备份旧插件并保留 data.json。
- [ ] Obsidian 实机检查与正式分支整合。
- [x] 文档和计划更新，保存开发分支代码。

## 验证记录

2026-11-01：完整测试以单并发运行，112/112通过（cache/publisher-final-tests.log）。之后补强导入互斥和组件控件清理，相关47/47通过；Biome通过；Astro production build成功，18页面。插件版本0.2.0，本机安装包与已安装文件校验一致。没有实际发布用户文章。

独立审查发现并已修复：封面/恢复操作前保存、重复弹窗、外部编辑基线、原生编辑器保存竞态、Markdown列表/引用/表格排版、重复图片数量变化错配、图片导入期间切换、JSON导入保护。相同引用数量改变时跳过歧义布局并提示重新核对；图片删除不删除附件。

工作台正文编辑目前使用Markdown文本编辑器，提供基础插入按钮和独立真实网页预览；概念图中的富文本显示不作为完整所见即所得编辑器。

实机进度：用户恢复了最小化窗口，随后按物理Esc停止Computer Use。本轮遵守停止，不再操作UI。插件尚需重载并验收图片面板/创建稿件/独立窗口/移动宽度；完成后再整合生产master。开发分支codex/publisher-editing，不推送正式分支。
