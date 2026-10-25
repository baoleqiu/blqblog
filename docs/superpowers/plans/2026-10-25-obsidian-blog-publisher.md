# Obsidian Blog Publisher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在这台 Windows 电脑交付可安装的 Obsidian 发布插件，提供独立元数据、真实主题预览及经过验证的 Git 发布/更新/下架。

**Architecture:** Obsidian 的独立视图与持久化模型调用一个本地 Node JSONL worker。worker 共用内容转换、图片和隔离工作目录，负责预览与发布事务；Git 和上线验证与 UI 解耦。

**Tech Stack:** Node >= 22、CommonJS Obsidian 插件、ESM worker、已有 Astro 6 / sharp / remark / KaTeX、Node 原生测试；不引入前端框架或远程服务。

**Spec:** `docs/superpowers/specs/2026-10-25-obsidian-blog-publisher-design.md`

## Global Constraints

- 使用现有 `E:\blqblog` checkout 的 `codex/obsidian-publisher` 分支，不创建额外工作树；保留用户 `.vscode/` 和 `AGENTS.md`。
- pnpm；Node.js >= 22；中文界面；普通路径和 Git 命令按参数传递。
- 插件数据单独保存，不写回原笔记；旧文章、现有主题样式及全站提速不属本次修改范围。
- 原图按字节保留，正文使用展示图；预览不推送，第一次真实发布等待用户审阅候选。
- 每项先写行为测试并观察失败；测试副作用仅在 `cache/` 临时目录及临时 Git 仓库。
- 当前用户已经确认设计并要求开发，直接以 native 方式执行，不再要求重复选择执行方式。

## Review Focus

- 转义、代码、同名附件、中文带空格路径：正确转换并且不读取错误文件，由任务 2 测试。
- 附件或主题改变而正文没变、异步旧结果返回：预览指纹失效且旧结果不得启用发布，由任务 3/5 测试。
- 源笔记在插件停用期间移动、导入错误备份：保持稳定文章 ID，不自动认领或覆盖，由任务 1 测试。
- 已有暂存、无关待推送提交、手工改过输出、推送中断：不夹带、不覆盖、可续传，由任务 4 测试。
- 上游推送成功但站点仍旧、下架/重发、程序中途关闭：不误报上线，不重复创建文章，由任务 4/5 测试。

## 文件与接口总览

- `integrations/obsidian-blog-publisher/manifest.json`, `src/{main,model,storage,view,settings,client}.cjs`, `styles.css`：插件及 UI。
- `scripts/obsidian-publisher/{common,convert,assets,workspace,preview,git,publish,worker}.mjs`：本地引擎。
- `scripts/obsidian-publisher/{build-plugin,install-plugin}.mjs`：可重复打包和安装；安装不覆盖 data.json。
- `tests/obsidian-publisher/*.test.{cjs,mjs}`：模型、转换、真实文件/临时 Git、worker 合约。
- `docs/obsidian-publisher.md`：用户使用与故障恢复；`package.json` 仅增加开发脚本。

统一快照 `NoteSnapshot`：`{ id, sourcePath, vaultRoot, markdown, metadata, resolutions, publishedLinks }`；resolutions 为 Obsidian 根据当前源文件解析的目标到库内绝对路径映射。

统一结果 `Candidate`：`{ id, articleUrl, markdown, metadata, assets, issues, contentFingerprint, fingerprint, files }`；issues 包含 `severity/code/message/line`，files 是相对仓库路径到 Buffer/字符串的输出清单。fingerprint 含主题、转换规则和附件内容；contentFingerprint 不因纯主题变化而误判正文更新。

worker 协议：stdin 每行 `{requestId, command, payload}`；stdout 每行 `{requestId, ok, result|error}` 或 `{event, data}`；日志仅 stderr，不输出正文或凭据。命令为 inspect、preview、publish、unpublish、resume、verify、stop。

### Task 1: 独立文章模型与数据保存

**Files:** 创建 `integrations/obsidian-blog-publisher/src/model.cjs`, `storage.cjs`；测试 `tests/obsidian-publisher/model.test.cjs`, `storage.test.cjs`。

**Interfaces:** `createState(settings)`, `bindNote(state, {path, basename, frontmatter})`, `renameSource(state, oldPath, newPath)`, `updateMetadata(record, patch)`, `validateImport(current, incoming)`；`DataStore(adapter, directory)` 提供 `load()/save(state)/export()/import(text)`。状态版本为 1，随机稳定 id 仅存数据文件。

- [ ] 写失败测试：同一笔记反复打开 ID 不变；修改标题不改 blogPath；导入不同库或重复 id 不覆盖；保存损坏时恢复上一份有效备份；首次属性初始化后不随源属性变动覆盖面板。
- [ ] 运行 `node --test tests/obsidian-publisher/model.test.cjs tests/obsidian-publisher/storage.test.cjs`，确认失败由缺失行为造成。
- [ ] 实现上述接口、字段校验、备份与导出；没有任何笔记写入接口。
- [ ] 重跑任务测试，预期全部通过；记录结果并精确提交模型与测试。

### Task 2: Markdown 与图片导出

**Files:** 创建 `scripts/obsidian-publisher/common.mjs`, `convert.mjs`, `assets.mjs`；测试 `tests/obsidian-publisher/convert.test.mjs`, `assets.test.mjs`。

**Interfaces:** `convertNote(snapshot): Promise<Candidate>`；`prepareImage({sourcePath, vaultRoot, id}): Promise<{originalUrl, displayUrl, files, hash, width, height}>`；`validateMetadata(metadata)`；`hash(data)`；`assertInside(root, path)`。

- [ ] 写失败测试：代码/转义中的双链不变；基础正文字符保留；解析真正图片引用、尺寸、别名；未发布链接转显示文字并提示；笔记嵌入/动态查询阻断；错误公式报出；元数据安全输出；附件越界/缺失阻断。
- [ ] 写图片失败测试：中文带空格路径；同名不同内容不冲突；原图 SHA-256 一致；展示图不放大且透明度正确；原图入口是单独有效链接；图片替换改变指纹。
- [ ] 运行 `node --test tests/obsidian-publisher/convert.test.mjs tests/obsidian-publisher/assets.test.mjs` 确认失败。
- [ ] 使用现有 `@astrojs/markdown-remark` 的解析钩子获取语法位置，按原文位置修改，避免重排全文；sharp 生成最大边 1920 的 WebP（质量 90，PNG/透明图采用 lossless），原文件独立输出；GIF 保留动画，未支持类型明确阻断。
- [ ] 重跑测试全部通过并提交；记录源文本/原附件未被修改的证据。

### Task 3: 工作目录、实时主题预览与 worker

**Files:** 创建 `scripts/obsidian-publisher/workspace.mjs`, `preview.mjs`, `worker.mjs`；测试 `tests/obsidian-publisher/workspace.test.mjs`, `worker.test.mjs`。

**Interfaces:** `syncWorkspace(repoRoot, workspaceRoot, overlay): Promise<{themeHash}>`；`PreviewManager(repoRoot).preview(snapshot)/stop()`；返回 `{url, fingerprint, contentFingerprint, issues, metadata}`；缓存最近候选供发布核对。

- [ ] 写失败测试：镜像排除 .git、node_modules、cache、插件数据；不写正式文章；删除过期镜像内容不越界；主题变化改变指纹；新候选覆盖旧结果；合法 JSONL 与错误均可关联请求。
- [ ] 运行任务测试确认失败，然后实现差量文件复制、主题指纹、单文章覆盖、回环端口和自有进程生命周期。
- [ ] worker 在 stdout 使用 JSONL，后台日志写 stderr；用 Node 执行仓库已有 Astro CLI，不触发包管理器下载。
- [ ] 重跑测试通过；用 CD8 只读快照启动实际 Astro 预览并检查路由、图片和字段，不发布。
- [ ] 精确提交引擎与测试。

### Task 4: 发布事务、Git 与上线验证

**Files:** 创建 `scripts/obsidian-publisher/git.mjs`, `publish.mjs`；测试 `tests/obsidian-publisher/publish.test.mjs`。

**Interfaces:** `GitRepo(root).preflight(settings)/commitPaths(paths,message)/push()/head()`；`Publisher(repoRoot, {build, fetchImpl, onProgress}).publish(candidate, settings)/unpublish(id,settings)/resume(operationId,settings)/verify(operationId,settings)`。生产使用真正整站构建；测试依赖注入仅替换外部构建/HTTP，Git 使用真实本地 bare remote。

- [ ] 写失败测试：精确文章提交且无关 untracked 不进入；已有暂存/超前/分歧阻断；手工改动输出阻断；构建失败无提交；推送失败保留操作并可续传；线上旧标记不是成功；下架不删除源文件；恢复沿用路径；原图仍可访问。
- [ ] 使用临时 Git 仓库运行测试确认失败，再实现原子操作记录、输出归属摘要、整站候选构建、变更前后检查、精确 Git 参数、版本标记与有限轮询。
- [ ] 非生产分支/未确认生产分支不允许真实发布；设置页明确此条件。无凭据落盘，无 force push/reset/全库清理。
- [ ] 重跑任务测试通过，提交事务实现。实际博客远端保持不变。

### Task 5: Obsidian 插件与可安装包

**Files:** 创建插件 `src/main.cjs`, `view.cjs`, `settings.cjs`, `client.cjs`、manifest/styles；打包和安装脚本；`tests/obsidian-publisher/plugin.test.cjs`, `client.test.cjs`；修改 package.json 添加 publisher 命令。

**Interfaces:** `PublisherClient(settings).request(command,payload)/dispose()`；插件用 model/DataStore 和 worker 协议。安装包只包含 manifest/main.js/styles.css；worker 保留在已配置博客项目。

- [ ] 写失败测试：目标绑定不随焦点切换；元数据只写插件目录；旧预览结果不能启用发布；附件变化触发刷新；重命名更新关联，删除保留发布记录；按钮不能在 preview 未完成或版本过期时调用 publish；worker 退出/挂起请求可恢复。
- [ ] 测试确认失败后实现中文字段、分类/标签建议、库内封面选择、自动刷新、iframe、记录列表、导入导出、重新关联、下架确认、进度与重试。
- [ ] 设置页提供项目路径、Node 路径、站点地址、生产分支确认；使用现有 Git 凭据。首次预览无需生产配置完成。
- [ ] 打包单文件 CommonJS；安装脚本只写明确目标插件目录、保留 data.json、备份已有程序文件；是否启用/加载按实际可用 Obsidian 接口完成，不通过不受支持的 native UI 操作。
- [ ] 任务测试通过，提交源代码与脚本；在安装前记录实际源笔记和图片哈希。

### Task 6: 整体验证、审阅与交付

**Files:** 创建 `docs/obsidian-publisher.md`；更新本计划和进度记录。

- [ ] 运行 `node --test tests/obsidian-publisher/*.test.cjs tests/obsidian-publisher/*.test.mjs`；运行打包与适用代码检查，逐一检查输出。
- [ ] 在隔离工作目录执行实际 `pnpm build` 的完整管线并记录结果；受环境影响的失败与代码失败分别处理，不声称未通过检查已通过。
- [ ] 在浏览器检查 CD8 笔记真实博客显示、分类标签、原图入口及七类格式样本；截图保存。
- [ ] 安装到实际库，用支持的 Obsidian 界面/CLI验证加载、分屏、字段保存与刷新；如环境无控制能力，明确留下最短用户验证步骤，不能把浏览器模拟当真实 Obsidian 验证。
- [ ] 委派一次 fresh whole-branch code review，处理重要问题并添加回归测试，重跑全套测试。
- [ ] 校验源文件/附件哈希、精确 Git 状态，写清已验证与仍需用户首次发布确认的边界；不自动发布、合并到 master 或推送分支。

## 自检与执行记录

覆盖检查：设计 1/4/5 → 任务 1/5；设计 6/7 → 任务 2；设计 8 → 任务 3/5；设计 9 → 任务 4；设计 10 → 任务 6。各任务统一使用 NoteSnapshot / Candidate / JSONL 接口。

执行方法：当前会话 native。进度账本放 `cache/obsidian-publisher-work/progress.md`，以适配 Windows 和现有已忽略目录；功能提交是可追踪边界。设计及本计划不再追加审批轮次，依据用户“确认，进行开发”的明确授权执行。
