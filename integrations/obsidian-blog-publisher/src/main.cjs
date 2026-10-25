const { Plugin, Notice, MarkdownView, TFile } = require("obsidian");
const path = require("node:path");
const model = require("./model.cjs");
const { DataStore } = require("./storage.cjs");
const { PublisherClient } = require("./client.cjs");
const { PublisherView, VIEW_TYPE } = require("./view.cjs");
const { PublisherSettings } = require("./settings.cjs");

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
				if (view.file?.path === this.record()?.sourcePath) this.invalidate();
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (
					file.path === this.record()?.sourcePath ||
					this.referencedPaths?.has(file.path)
				)
					this.invalidate();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				model.renameSource(this.state, oldPath, file.path);
				this.safe(() => this.save());
				this.view()?.render();
				this.invalidate();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				model.markSourceMissing(this.state, file.path);
				this.safe(() => this.save());
				this.view()?.render();
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
			this.view()?.render();
			this.invalidate();
		});
	}
	async safe(fn) {
		try {
			return await fn();
		} catch (error) {
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
		if (this.view()?.control.publishing)
			throw Error("发布正在进行，请完成后切换目标。");
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
	getClient() {
		if (!this.client)
			this.client = new PublisherClient(this.state.settings, (event, data) => {
				if (event === "theme-change") this.invalidate();
				if (event === "progress") this.view()?.message(data.message);
			});
		return this.client;
	}
	async snapshot(record) {
		const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
		if (!(file instanceof TFile)) {
			record.sourceMissing = true;
			await this.save();
			throw Error("原笔记已移走或删除。线上文章保留，可在发布记录中重新关联。");
		}
		let markdown;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (
				leaf.view instanceof MarkdownView &&
				leaf.view.file?.path === file.path
			)
				markdown = leaf.view.editor.getValue();
		});
		markdown ??= await this.app.vault.read(file);
		const resolutions = {};
		const cache = this.app.metadataCache.getFileCache(file);
		const targets = new Set([
			record.metadata.cover,
			...[...(cache?.links || []), ...(cache?.embeds || [])].map((x) => x.link),
		]);
		for (const match of markdown.matchAll(/!?\[\[([^\]\r\n]+)\]\]/g))
			targets.add(match[1].split("|")[0]);
		for (const match of markdown.matchAll(
			/!?\[[^\]\r\n]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g,
		))
			targets.add(match[1]);
		for (const match of markdown.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm))
			targets.add(match[1]);
		this.referencedPaths = new Set();
		for (let target of targets) {
			if (!target || /^https?:\/\//i.test(target)) continue;
			target = target.split("#")[0];
			try {
				target = decodeURIComponent(target);
			} catch {}
			const resolved = this.app.metadataCache.getFirstLinkpathDest(
				target,
				file.path,
			);
			if (resolved instanceof TFile) {
				this.referencedPaths.add(resolved.path);
				resolutions[target] = {
					path: path.join(this.app.vault.adapter.getBasePath(), resolved.path),
					notePath: resolved.path,
					kind: resolved.extension === "md" ? "note" : "image",
				};
			}
		}
		const publishedLinks = Object.fromEntries(
			this.state.records
				.filter((r) => r.lastPublished && r.status !== "unpublished")
				.map((r) => [r.sourcePath, r.blogPath]),
		);
		return {
			id: record.id,
			sourcePath: record.sourcePath,
			vaultRoot: this.app.vault.adapter.getBasePath(),
			markdown,
			metadata: structuredClone(record.metadata),
			lastPublished: structuredClone(record.lastPublished),
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
		for (const op of result.operations || []) {
			const record = this.state.records.find((r) => r.id === op.id);
			if (!record) continue;
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
		await this.save();
	}
	onunload() {
		this.closeClient();
	}
};
