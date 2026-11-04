const { Plugin, Notice, MarkdownView, TFile } = require("obsidian");
const path = require("node:path");
const model = require("./model.cjs");
const { DataStore } = require("./storage.cjs");
const { PublisherClient } = require("./client.cjs");
const { PublisherView, VIEW_TYPE } = require("./view.cjs");
const { PublisherSettings } = require("./settings.cjs");
const {
	PreviewWindowView,
	PREVIEW_VIEW_TYPE,
} = require("./preview-window.cjs");
const drafts = require("./drafts.cjs");
const { listImages } = require("./image-layout.cjs");
const { randomUUID } = require("node:crypto");

module.exports = class BlogPublisher extends Plugin {
	async onload() {
		const adapter = this.app.vault.adapter;
		if (typeof adapter.getBasePath !== "function")
			throw Error("博客发布器只支持电脑上的本地笔记库。");
		this.store = new DataStore(
			adapter,
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
		);
		this.state =
			(await this.store.load()) ||
			model.createState({ vaultRoot: adapter.getBasePath() });
		if (this.store.recovered)
			new Notice("发布数据已从上一份有效备份恢复，请导出备份保存。", 10000);
		this.lastMarkdown = this.app.workspace.getActiveFile();
		this.registerView(VIEW_TYPE, (leaf) => new PublisherView(leaf, this));
		this.registerView(
			PREVIEW_VIEW_TYPE,
			(leaf) => new PreviewWindowView(leaf, this),
		);
		this.addSettingTab(new PublisherSettings(this.app, this));
		this.addRibbonIcon("send", "博客预览与发布", () =>
			this.safe(() => this.openPanel()),
		);
		this.addCommand({
			id: "open-publisher",
			name: "打开博客预览与发布",
			callback: () => this.safe(() => this.openPanel()),
		});
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file?.extension === "md") this.lastMarkdown = file;
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, view) => {
				if (view.file?.path === this.contentPath(this.record()))
					this.invalidate();
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (
					file.path === this.contentPath(this.record()) ||
					this.referencedPaths?.has(file.path)
				)
					this.invalidate();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const selected = this.contentPath(this.record());
				model.renameSource(this.state, oldPath, file.path);
				this.safe(() => this.save());
				this.contentFilesChanged();
				if (
					this.pathAffected(selected, oldPath) ||
					[...(this.referencedPaths || [])].some((p) =>
						this.pathAffected(p, oldPath),
					)
				)
					this.invalidate();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				model.markSourceMissing(this.state, file.path);
				this.safe(() => this.save());
				this.contentFilesChanged();
				if (
					this.pathAffected(this.contentPath(this.record()), file.path) ||
					[...(this.referencedPaths || [])].some((p) =>
						this.pathAffected(p, file.path),
					)
				)
					this.invalidate();
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				if (this.view() && this.record()) this.invalidate();
			}),
		);
		this.app.workspace.onLayoutReady(() => {
			model.reconcileSources(
				this.state,
				(sourcePath) =>
					this.app.vault.getAbstractFileByPath(sourcePath) instanceof TFile,
			);
			this.safe(() => this.save());
			this.contentFilesChanged();
			this.invalidate();
		});
	}
	async safe(fn) {
		try {
			return await fn();
		} catch (error) {
			if (error.code === "PUBLISHER_CLOSED") return;
			new Notice(error.message, 10000);
			this.view()?.message(error.message, true);
		}
	}
	view() {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
	}
	record() {
		return this.state.records.find(
			(r) => r.id === this.state.settings.lastRecordId,
		);
	}
	save() {
		return this.store.save(this.state);
	}
	async bind(file) {
		this.assertEditable();
		await this.view()?.flushDraft?.();
		this.assertEditable();
		if (!(file instanceof TFile) || file.extension !== "md")
			throw Error("请先打开一篇 Markdown 笔记。");
		const record = model.bindNote(this.state, {
			path: file.path,
			basename: file.basename,
			frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
		});
		this.state.settings.lastRecordId = record.id;
		await this.save();
		this.view()?.bind(record);
		return record;
	}
	async openPanel() {
		const existing = this.view();
		if (existing) {
			await this.app.workspace.revealLeaf(existing.leaf);
			return;
		}
		const file = this.app.workspace.getActiveFile() || this.lastMarkdown;
		if (file?.extension === "md") await this.bind(file);
		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
	invalidate() {
		this.view()?.changed();
	}
	pathAffected(value, parent) {
		const key = model.pathKey(value);
		const prefix = model.pathKey(parent);
		return Boolean(
			key && prefix && (key === prefix || key.startsWith(`${prefix}/`)),
		);
	}
	contentFilesChanged() {
		const view = this.view();
		const record = this.record();
		if (view?.control && record)
			view.control.missing = Boolean(
				record.contentMode === "draft"
					? record.draftMissing
					: record.sourceMissing,
			);
		view?.filesChanged?.();
		view?.updateButtons?.();
	}
	assertEditable() {
		if (this.importingData) throw Error("发布数据正在导入，请稍后编辑或发布。");
		if (this.view()?.control?.publishing)
			throw Error("发布正在进行，请完成后编辑或切换正文。");
	}
	contentPath(record) {
		if (!record) return undefined;
		return record.contentMode === "draft"
			? record.draftPath
			: record.sourcePath;
	}
	async contentFile(record) {
		const selected = this.contentPath(record);
		const file = selected && this.app.vault.getAbstractFileByPath(selected);
		const field =
			record.contentMode === "draft" ? "draftMissing" : "sourceMissing";
		if (!(file instanceof TFile) || file.extension !== "md") {
			record[field] = true;
			await this.save();
			this.contentFilesChanged();
			throw Error(
				record.contentMode === "draft"
					? "博客稿已移走或删除，请重新关联稿件或切回原笔记；未自动覆盖稿件。"
					: "原笔记已移走或删除。线上文章保留，可在发布记录中重新关联。",
			);
		}
		record[field] = false;
		return file;
	}
	editorsFor(file) {
		const editors = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (
				leaf.view instanceof MarkdownView &&
				leaf.view.file?.path === file.path
			)
				editors.push(leaf.view.editor);
		});
		return editors;
	}
	async readContent(record) {
		const file = await this.contentFile(record);
		const disk = await this.app.vault.read(file);
		const editors = this.editorsFor(file);
		let value = disk;
		if (editors.length) {
			value = editors[0].getValue();
			if (editors.some((editor) => editor.getValue() !== value))
				throw Error("同一正文的编辑窗口存在冲突，请先保存并统一内容。");
		}
		this.readRevisions ||= new Map();
		this.readRevisions.set(file.path, { text: value, disk });
		return value;
	}
	queueDraft(record, work) {
		this.draftWrites ||= new Map();
		const pending = (this.draftWrites.get(record.id) || Promise.resolve())
			.catch(() => {})
			.then(work);
		this.draftWrites.set(record.id, pending);
		return pending.finally(() => {
			if (this.draftWrites.get(record.id) === pending)
				this.draftWrites.delete(record.id);
		});
	}
	async createDraft(record) {
		this.assertEditable();
		await this.view()?.flushDraft?.();
		return this.queueDraft(record, async () => {
			this.assertEditable();
			if (record.draftPath) {
				await this.contentFile({ ...record, contentMode: "draft" });
				record.contentMode = "draft";
				await this.save();
				this.invalidate();
				return record;
			}
			const markdown = await this.readContent({
				...record,
				contentMode: "source",
			});
			const moved = drafts.moveReferences(
				markdown,
				record.sourcePath,
				this.app,
			);
			const folder = `博客稿/${record.id}`;
			await drafts.ensureFolders(this.app.vault, folder);
			const filename = `${folder}/${drafts.safeName(record.metadata.title)}.md`;
			if (this.app.vault.getAbstractFileByPath(filename))
				throw Error("博客稿文件已存在，未覆盖，请先检查或重新关联。");
			this.assertEditable();
			await this.app.vault.create(filename, moved);
			const layouts = { ...(record.imageLayouts || {}) };
			const previous = listImages(markdown);
			listImages(moved).forEach((item, index) => {
				if (layouts[previous[index]?.key])
					layouts[item.key] = structuredClone(layouts[previous[index].key]);
			});
			record.imageLayouts = layouts;
			record.draftPath = filename;
			record.draftMissing = false;
			record.contentMode = "draft";
			await this.save();
			this.invalidate();
			return record;
		});
	}
	async setContentMode(record, mode) {
		this.assertEditable();
		if (!["source", "draft"].includes(mode)) throw Error("正文来源无效。");
		await this.view()?.flushDraft?.();
		this.assertEditable();
		await this.contentFile({ ...record, contentMode: mode });
		record.contentMode = mode;
		await this.save();
		this.contentFilesChanged();
		this.invalidate();
		return record;
	}
	async saveDraft(record, text, expectedText) {
		this.assertEditable();
		if (typeof text !== "string" || typeof expectedText !== "string")
			throw Error("博客稿保存需要正文及原版本，以避免外部修改冲突。");
		return this.queueDraft(record, async () => {
			this.assertEditable();
			if (!record.draftPath) throw Error("请先创建博客稿。");
			const selected = { ...record, contentMode: "draft" };
			const file = await this.contentFile(selected);
			const editors = this.editorsFor(file);
			const baseline = this.readRevisions?.get(file.path);
			if (editors.some((editor) => editor.getValue() !== expectedText))
				throw Error(
					"博客稿已在其他编辑窗口修改，保存冲突；请先重新读取或保留副本。",
				);
			if (typeof this.app.vault.process !== "function")
				throw Error("当前 Obsidian 不支持安全保存博客稿，请更新后重试。");
			await this.app.vault.process(file, (current) => {
				this.assertEditable();
				if (
					this.editorsFor(file).some(
						(editor) => editor.getValue() !== expectedText,
					)
				)
					throw Error(
						"博客稿已在其他编辑窗口修改，保存冲突；请先重新读取或保留副本。",
					);
				if (
					current !== expectedText &&
					!(baseline?.text === expectedText && current === baseline.disk)
				)
					throw Error("博客稿已被外部修改，保存冲突；请先重新读取或保留副本。");
				return text;
			});
			const currentEditors = this.editorsFor(file);
			const divergent = currentEditors.some(
				(editor) => ![expectedText, text].includes(editor.getValue()),
			);
			if (!divergent)
				for (const editor of currentEditors)
					if (editor.getValue() === expectedText) editor.setValue(text);
			if (
				divergent ||
				this.editorsFor(file).some((editor) => editor.getValue() !== text)
			) {
				this.readRevisions?.delete(file.path);
				this.invalidate();
				let recoveryPath;
				try {
					recoveryPath = await this.saveDraftRecovery(record, text);
				} catch (error) {
					throw Error(
						`博客稿保存期间其他编辑窗口发生修改，保存冲突；恢复副本未能写入，请保留工作台正文：${error.message}`,
					);
				}
				const error = Error(
					`博客稿保存期间其他编辑窗口发生修改，保存冲突；未覆盖编辑窗口，工作台正文已保留到：${recoveryPath}`,
				);
				error.code = "DRAFT_CONFLICT";
				error.recoveryPath = recoveryPath;
				throw error;
			}
			this.readRevisions ||= new Map();
			this.readRevisions.set(file.path, { text, disk: text });
			if (record.contentMode === "draft") this.invalidate();
			return text;
		});
	}
	async saveDraftRecovery(record, text) {
		if (typeof text !== "string") throw Error("恢复副本正文无效。");
		if (!record.draftPath) throw Error("博客稿路径缺失，无法保存恢复副本。");
		const folder = path.posix.dirname(drafts.safeVaultPath(record.draftPath));
		await drafts.ensureFolders(this.app.vault, folder);
		const filename = `${folder}/${drafts.safeName(path.posix.basename(record.draftPath, ".md"))}-冲突副本-${Date.now()}-${randomUUID().slice(0, 8)}.md`;
		await this.app.vault.create(filename, text);
		return filename;
	}
	async insertDraftImage(record, input) {
		this.assertEditable();
		if (record.contentMode !== "draft" || !record.draftPath)
			throw Error("请先切换到博客稿后插入图片。");
		const file = await this.contentFile(record);
		if (!input || typeof input.arrayBuffer !== "function")
			throw Error("请选择有效图片。");
		if (Number(input.size) > drafts.MAX_IMAGE_BYTES)
			throw Error("图片过大，请缩小到 20 MiB 以内。");
		const bytes = Buffer.from(await input.arrayBuffer());
		if (!bytes.length || bytes.length > drafts.MAX_IMAGE_BYTES)
			throw Error("图片大小无效或超过 20 MiB。");
		const extension = drafts.imageExtension(bytes);
		const stem = drafts.safeName(input.name || "图片").replace(/\.[^.]+$/, "");
		const name = `${stem}-${randomUUID().slice(0, 8)}.${extension}`;
		const target = drafts.safeVaultPath(
			await this.app.fileManager.getAvailablePathForAttachment(name, file),
		);
		if (this.app.vault.getAbstractFileByPath(target))
			throw Error("附件文件名冲突，未覆盖原附件，请重试。");
		this.assertEditable();
		await this.app.vault.createBinary(
			target,
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		);
		return `![](${drafts.rootReference(target)})`;
	}
	imageFile(record, item) {
		const file = drafts.resolveFile(
			this.app,
			typeof item === "string" ? item : item?.target,
			this.contentPath(record),
		);
		return file instanceof TFile ? file : null;
	}
	async openDraftExternal(record, preferVSCode = true) {
		this.assertEditable();
		await this.view()?.flushDraft?.();
		if (!record.draftPath) throw Error("请先创建博客稿。");
		const file = await this.contentFile({ ...record, contentMode: "draft" });
		const relative = drafts.safeVaultPath(file.path);
		const absolute = path.join(this.app.vault.adapter.getBasePath(), relative);
		const { shell } = require("electron");
		if (preferVSCode) {
			const url = `vscode://file/${encodeURI(absolute.replaceAll("\\", "/")).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
			try {
				await shell.openExternal(url);
				return;
			} catch {}
		}
		const error = await shell.openPath(absolute);
		if (error) throw Error(`无法打开博客稿：${error}`);
	}
	getClient() {
		if (!this.client)
			this.client = new PublisherClient(this.state.settings, (event, data) => {
				if (event === "theme-change") this.invalidate();
				if (event === "progress") this.view()?.message(data.message);
			});
		return this.client;
	}
	async snapshot(record) {
		await this.draftWrites?.get(record.id);
		const file = await this.contentFile(record);
		const markdown = await this.readContent(record);
		const resolutions = {};
		const cache = this.app.metadataCache.getFileCache(file);
		const targets = new Set([
			record.metadata.cover,
			...[...(cache?.links || []), ...(cache?.embeds || [])].map((x) => x.link),
		]);
		for (const range of drafts.referenceRanges(markdown))
			targets.add(range.target);
		this.referencedPaths = new Set();
		for (const rawTarget of targets) {
			const target = drafts.cleanTarget(rawTarget);
			const resolved =
				drafts.resolveFile(this.app, rawTarget, file.path) ||
				(rawTarget === record.metadata.cover
					? drafts.resolveFile(this.app, rawTarget, record.sourcePath)
					: null);
			if (resolved instanceof TFile) {
				this.referencedPaths.add(resolved.path);
				resolutions[target] = resolutions[rawTarget] = {
					path: path.join(this.app.vault.adapter.getBasePath(), resolved.path),
					notePath: resolved.path,
					kind:
						resolved.extension === "md"
							? "note"
							: resolved.extension.toLowerCase() === "mp4"
								? "video"
								: "image",
				};
			}
		}
		const publishedLinks = Object.fromEntries(
			this.state.records
				.filter((r) => r.lastPublished && r.status !== "unpublished")
				.flatMap((r) =>
					[r.sourcePath, ...(r.draftPath ? [r.draftPath] : [])].map((p) => [
						p,
						r.blogPath,
					]),
				),
		);
		return {
			id: record.id,
			sourcePath: record.sourcePath,
			contentPath: file.path,
			contentMode: record.contentMode || "source",
			...(record.draftPath ? { draftPath: record.draftPath } : {}),
			vaultRoot: this.app.vault.adapter.getBasePath(),
			markdown,
			metadata: structuredClone(record.metadata),
			lastPublished: structuredClone(record.lastPublished),
			imageLayouts: structuredClone(record.imageLayouts || {}),
			resolutions,
			publishedLinks,
		};
	}
	async closeClient() {
		const client = this.client;
		this.client = null;
		await client?.dispose();
	}
	async recover() {
		if (!this.state.settings.repoPath) return;
		const result = await this.getClient().request("inspect");
		const pending = new Map();
		for (const op of result.operations || []) {
			const record = this.state.records.find((r) => r.id === op.id);
			if (!record) continue;
			if (["prepared", "committed"].includes(op.status)) pending.set(op.id, op);
			record.operation = op;
			record.status = op.status;
			if (op.status === "live")
				record.lastPublished = {
					contentFingerprint: op.contentFingerprint,
					commit: op.commit,
					updated: op.updated,
				};
			if (op.status === "unpublished") record.lastPublished = null;
		}
		for (const [id, op] of pending) {
			const record = this.state.records.find((r) => r.id === id);
			record.operation = op;
			record.status = op.status;
		}
		await this.save();
	}
	onunload() {
		this.app.workspace.detachLeavesOfType?.(PREVIEW_VIEW_TYPE);
		this.closeClient();
	}
};
