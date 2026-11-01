const {
	ItemView,
	Setting,
	Notice,
	FuzzySuggestModal,
	Modal,
	Menu,
	setIcon,
} = require("obsidian");
const { PreviewController } = require("./controller.cjs");
const model = require("./model.cjs");
const { ArticleContent } = require("./workbench-content.cjs");
const { PREVIEW_VIEW_TYPE } = require("./preview-window.cjs");
const VIEW_TYPE = "blqblog-publisher";
const PREVIEW_INTERVAL = 60_000;
const labels = {
	draft: "本地草稿",
	prepared: "检查与提交中",
	committed: "提交完成，待推送",
	pushed: "已推送，待上线确认",
	live: "已上线",
	unpublished: "已下架",
};
class FilePicker extends FuzzySuggestModal {
	constructor(app, filter, choose) {
		super(app);
		this.filter = filter;
		this.choose = choose;
		this.setPlaceholder("输入文件名搜索");
	}
	getItems() {
		return this.app.vault.getFiles().filter(this.filter);
	}
	getItemText(file) {
		return file.path;
	}
	onChooseItem(file) {
		this.choose(file);
	}
}
class Confirm extends Modal {
	constructor(app, title, text, action) {
		super(app);
		this.title = title;
		this.text = text;
		this.action = action;
	}
	onOpen() {
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("确认下架")
					.setWarning()
					.onClick(() => {
						this.close();
						this.action();
					}),
			);
	}
}
class PublisherView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.control = new PreviewController();
		this.timer = null;
		this.dirty = false;
		this.refreshing = false;
		this.refreshAfterBusy = false;
		this.closed = false;
		this.metadataOpen = false;
	}
	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return "博客预览与发布";
	}
	getIcon() {
		return "send";
	}
	async onOpen() {
		this.closed = false;
		await this.plugin.safe(() => this.plugin.recover());
		if (this.closed) return;
		this.bind(this.plugin.record());
	}
	async onClose() {
		try {
			await this.flushDraft();
		} catch {
			if (this.article?.record.contentMode === "draft") {
				const saved = await this.plugin.saveDraftRecovery(
					this.article.record,
					this.article.text,
				);
				new Notice(`保存有冲突，未保存正文已保留到：${saved}`, 12000);
			}
		}
		this.article?.dispose();
		this.closed = true;
		this.popup?.leaf.detach();
		clearTimeout(this.timer);
		this.timer = null;
		this.control.invalidate();
		await this.plugin.closeClient();
	}
	handlePreviewMessage(event) {
		const result = this.frameResult;
		if (
			this.closed ||
			!result ||
			!this.frame ||
			event.source !== this.frame.contentWindow ||
			event.origin !== new URL(result.url).origin ||
			event.data?.fingerprint !== result.fingerprint
		)
			return;
		if (event.data.type === "blq-preview-scroll") {
			if (Number.isFinite(event.data.position))
				this.scrollPosition = event.data.position;
			return;
		}
		if (
			event.data.type !== "blq-preview-ready" ||
			this.frameGeneration !== this.control.generation
		)
			return;
		this.control.displayed(event.data.fingerprint);
		this.popup?.setStatus("预览已更新");
		this.buttons();
		this.message(
			result.issues.some((x) => x.severity === "error")
				? "预览已显示，请先处理标出的问题。"
				: "预览已就绪，已核对当前文章版本。",
		);
		this.frame.contentWindow.postMessage(
			{ type: "blq-scroll-to", position: this.scrollPosition || 0 },
			event.origin,
		);
	}
	bind(record) {
		this.scrollPosition = 0;
		this.control.bind(record?.id);
		this.render();
		this.dirty = Boolean(record);
		if (record) {
			if (this.refreshing) this.refreshAfterBusy = true;
			else this.plugin.safe(() => this.refresh());
		}
	}
	message(text, error = false) {
		this.popup?.setStatus(text);
		if (this.statusEl) {
			this.statusText.setText(text);
			this.statusEl.toggleClass("blq-error", error);
			setIcon(this.statusIcon, error ? "circle-alert" : "info");
		}
	}
	async flushDraft() {
		await this.article?.flush();
	}
	filesChanged() {
		const record = this.plugin.record();
		this.control.missing =
			record?.contentMode === "draft"
				? record.draftMissing
				: record?.sourceMissing;
		if (this.control.missing)
			this.message("当前发布文件已移走或删除，请检查文件位置。", true);
		this.buttons();
	}
	async openPreviewWindow() {
		if (this.openingWindow) return this.openingWindow;
		this.openingWindow = this.openPreviewWindowOnce();
		try {
			return await this.openingWindow;
		} finally {
			this.openingWindow = null;
		}
	}
	async openPreviewWindowOnce() {
		await this.flushDraft();
		if (this.closed) return;
		if (!this.popup) {
			const screen = this.contentEl.ownerDocument.defaultView.screen;
			const leaf = this.app.workspace.openPopoutLeaf({
				size: {
					width: Math.round(screen.availWidth * 0.9),
					height: Math.round(screen.availHeight * 0.9),
				},
			});
			await leaf.setViewState({ type: PREVIEW_VIEW_TYPE, active: true });
			if (this.closed) {
				leaf.detach();
				return;
			}
			this.popup = leaf.view;
			this.popup.owner = this;
		}
		await this.app.workspace.revealLeaf(this.popup.leaf);
		this.showWindowResult();
		if (this.dirty && !this.refreshing) await this.refresh();
	}
	showWindowResult() {
		if (!this.popup || !this.frameResult) return;
		this.frame = this.popup.update(this.frameResult, this.frameGeneration);
		if (this.frameGeneration === this.control.generation) {
			this.control.displayedFingerprint = null;
			this.buttons();
			this.frame.contentWindow?.postMessage(
				{ type: "blq-preview-request" },
				new URL(this.frameResult.url).origin,
			);
		}
	}
	chooseNote(record) {
		if (this.control.publishing) return;
		new FilePicker(
			this.app,
			(f) => f.extension === "md",
			(file) =>
				this.plugin.safe(async () => {
					if (this.control.publishing) return;
					await this.flushDraft();
					if (record) {
						if (this.plugin.record()?.id !== record.id) return;
						model.relinkSource(this.plugin.state, record.id, file.path);
						await this.plugin.save();
						this.bind(record);
					} else await this.plugin.bind(file);
				}),
		).open();
	}
	showMenu(event) {
		const record = this.plugin.record();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("绑定当前笔记")
				.setIcon("file-plus")
				.setDisabled(this.control.publishing)
				.onClick(() =>
					this.plugin.safe(() =>
						this.plugin.bind(
							this.app.workspace.getActiveFile() || this.plugin.lastMarkdown,
						),
					),
				),
		);
		menu.addItem((item) =>
			item
				.setTitle("选择其他笔记")
				.setIcon("files")
				.setDisabled(this.control.publishing)
				.onClick(() => this.chooseNote()),
		);
		if (record?.lastPublished && record.status !== "unpublished") {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("下架文章…")
					.setIcon("archive")
					.setDisabled(this.control.publishing)
					.onClick(() => {
						if (
							this.control.publishing ||
							this.plugin.record()?.id !== record.id
						)
							return;
						new Confirm(
							this.app,
							"下架这篇博客文章",
							`将从网站移除《${record.metadata.title}》。原笔记、发布信息和 Git 历史保留，可重新发布。`,
							() =>
								this.plugin.safe(() => {
									if (this.plugin.record()?.id !== record.id)
										throw Error("文章已切换，请重新确认下架目标。");
									return this.operation("unpublish", { id: record.id });
								}),
						).open();
					}),
			);
		}
		menu.showAtMouseEvent(event);
	}
	updateMetadataSummary(record) {
		this.metadataSummary?.setText(
			[
				record.metadata.category || "未分类",
				`${record.metadata.tags.length} 个标签`,
				record.metadata.published || "日期自动填写",
			].join(" · "),
		);
	}
	render() {
		this.article?.dispose();
		this.popup?.clear();
		this.control.invalidate();
		this.frame = null;
		this.frameResult = null;
		this.publishButton = null;
		this.refreshButton = null;
		this.browserButton = null;
		this.footerStatus = null;
		this.metadataSummary = null;
		this.editControls = [];
		const el = this.contentEl;
		el.empty();
		el.addClass("blq-publisher");
		const record = this.plugin.record();
		const header = el.createDiv({ cls: "blq-header" });
		setIcon(header.createSpan({ cls: "blq-brand-icon" }), "send");
		header.createEl("h2", { text: "博客工作台" });
		const more = header.createEl("button", {
			cls: "blq-more clickable-icon",
			attr: { "aria-label": "更多操作", "aria-haspopup": "menu" },
		});
		setIcon(more, "ellipsis");
		more.addEventListener("click", (event) => this.showMenu(event));
		const body = el.createDiv({ cls: "blq-body" });
		const selection = body.createDiv({ cls: "blq-selection" });
		const records = selection.createEl("select", {
			attr: { "aria-label": "发布记录" },
		});
		this.editControls.push(records);
		records.createEl("option", { text: "选择发布记录", value: "" });
		for (const item of this.plugin.state.records)
			records.createEl("option", {
				text: item.metadata.title,
				value: item.id,
			});
		records.value = record?.id || "";
		records.addEventListener("change", () =>
			this.plugin.safe(async () => {
				if (!records.value || this.control.publishing) return;
				await this.flushDraft();
				this.plugin.state.settings.lastRecordId = records.value;
				await this.plugin.save();
				this.bind(this.plugin.record());
			}),
		);
		if (record)
			selection.createSpan({
				cls: "blq-state",
				text: record.sourceMissing
					? "原笔记缺失"
					: labels[record.status] || record.status,
			});
		this.statusEl = body.createDiv({
			cls: "blq-status",
			attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
		});
		this.statusIcon = this.statusEl.createSpan({
			cls: "blq-status-icon",
			attr: { "aria-hidden": "true" },
		});
		this.statusText = this.statusEl.createSpan();
		if (!record) {
			const empty = body.createDiv({ cls: "blq-empty" });
			setIcon(empty.createSpan({ cls: "blq-empty-icon" }), "file-text");
			empty.createEl("h3", { text: "把笔记变成一篇博客" });
			empty.createEl("p", { text: "选择笔记，在这里预览和发布。" });
			this.button(empty, "选择笔记", () => this.chooseNote());
			this.message("选择一篇笔记，开始预览。");
			return;
		}
		this.control.id = record.id;
		this.control.missing =
			record.contentMode === "draft"
				? record.draftMissing
				: record.sourceMissing;
		const source = body.createDiv({ cls: "blq-source-row" });
		source.createEl("p", {
			text: `原笔记：${record.sourcePath}`,
			cls: "blq-source",
			attr: { title: record.sourcePath },
		});
		const choose = this.button(
			source,
			record.sourceMissing ? "重新关联笔记" : "更换笔记",
			() => this.chooseNote(record.sourceMissing ? record : null),
		);
		choose.addClass("blq-text-button");
		this.editControls.push(choose);
		const mode = body.createDiv({ cls: "blq-content-mode" });
		mode.createSpan({
			text: `当前发布：${record.contentMode === "draft" ? "博客稿" : "原笔记"}`,
			cls: "blq-mode-label",
		});
		const draftButton = this.button(
			mode,
			record.contentMode === "draft"
				? "切回原笔记"
				: record.draftPath
					? "继续编辑博客稿"
					: "创建博客稿",
			async () => {
				await this.flushDraft();
				if (record.contentMode === "draft")
					await this.plugin.setContentMode(record, "source");
				else if (record.draftPath)
					await this.plugin.setContentMode(record, "draft");
				else await this.plugin.createDraft(record);
				this.bind(record);
			},
		);
		this.editControls.push(draftButton);
		mode.createSpan({
			text:
				record.contentMode === "draft"
					? "正文独立保存，附件共用"
					: "在左侧编辑正文；图片排版单独保存",
			cls: "blq-muted",
		});
		const fields = body.createEl("details", { cls: "blq-fields" });
		fields.open = this.metadataOpen;
		fields.addEventListener("toggle", () => {
			this.metadataOpen = fields.open;
		});
		const summary = fields.createEl("summary");
		summary.createSpan({ text: "发布信息", cls: "blq-fields-title" });
		this.metadataSummary = summary.createSpan({ cls: "blq-metadata-summary" });
		this.updateMetadataSummary(record);
		const grid = fields.createDiv({ cls: "blq-field-grid" });
		for (const [key, label, type] of [
			["title", "博客标题", "text"],
			["category", "分类", "text"],
			["tags", "标签（逗号分隔）", "text"],
			["published", "发布日期", "date"],
			["description", "摘要", "textarea"],
		]) {
			const wrapper = grid.createEl("label", { cls: `blq-field blq-${key}` });
			wrapper.createSpan({ text: label });
			const input = wrapper.createEl(
				type === "textarea" ? "textarea" : "input",
			);
			if (type !== "textarea") input.type = type;
			input.value =
				key === "tags"
					? record.metadata.tags.join(", ")
					: record.metadata[key] || "";
			input.setAttribute("data-field", key);
			input.disabled = this.control.publishing;
			this.editControls.push(input);
			if (key === "published") input.setAttribute("max", model.today());
			input.addEventListener("input", () => {
				if (this.control.publishing) return;
				model.updateMetadata(record, {
					[key]: key === "tags" ? input.value.split(/[,，\n]/) : input.value,
				});
				this.plugin.safe(() => this.plugin.save());
				this.updateMetadataSummary(record);
				this.changed();
			});
			if (key === "category" || key === "tags") {
				const list = wrapper.createEl("datalist", {
					attr: { id: `blq-${key}-suggestions` },
				});
				const suggestions = new Set(
					this.plugin.state.records.flatMap((r) =>
						key === "tags" ? r.metadata.tags : [r.metadata.category],
					),
				);
				for (const value of suggestions)
					if (value) list.createEl("option", { value });
				input.setAttribute("list", list.id);
			}
		}
		const cover = fields.createDiv({ cls: "blq-cover" });
		cover.createSpan({ text: `封面：${record.metadata.cover || "未设置"}` });
		this.editControls.push(
			this.button(cover, "选择封面", () =>
				new FilePicker(
					this.app,
					(f) => /^(jpg|jpeg|png|webp|gif|avif)$/i.test(f.extension),
					(file) =>
						this.plugin.safe(async () => {
							if (
								this.control.publishing ||
								this.plugin.record()?.id !== record.id
							)
								return;
							await this.flushDraft();
							model.updateMetadata(record, { cover: file.path });
							await this.plugin.save();
							this.render();
							this.changed();
						}),
				).open(),
			),
		);
		this.editControls.push(
			this.button(cover, "清除", async () => {
				if (this.control.publishing) return;
				await this.flushDraft();
				model.updateMetadata(record, { cover: "" });
				await this.plugin.save();
				this.render();
				this.changed();
			}),
		);
		const bar = body.createDiv({ cls: "blq-preview-toolbar" });
		bar.createSpan({ text: "博客预览", cls: "blq-section-title" });
		this.windowButton = this.button(bar, "窗口预览", () =>
			this.openPreviewWindow(),
		);
		this.windowButton.addClass("blq-window-button");
		this.refreshButton = this.button(bar, "刷新预览", () => this.refresh());
		this.refreshButton.addClass("blq-text-button");
		this.browserButton = this.button(bar, "在浏览器预览", () => {
			if (this.frameResult)
				require("electron").shell.openExternal(this.frameResult.url);
		});
		this.browserButton.addClass("blq-browser-button");
		setIcon(
			this.browserButton.createSpan({ attr: { "aria-hidden": "true" } }),
			"external-link",
		);
		this.issuesEl = body.createDiv({ cls: "blq-issues" });
		const content = body.createDiv({ cls: "blq-article-content" });
		this.article = new ArticleContent(this, content, record);
		const footer = el.createDiv({ cls: "blq-footer" });
		this.footerStatus = footer.createSpan({
			cls: "blq-footer-status",
			attr: { role: "status" },
		});
		const actions = footer.createDiv({ cls: "blq-actions" });
		this.publishButton = this.button(
			actions,
			record.lastPublished ? "更新文章" : "发布文章",
			() => this.publish(),
		);
		this.publishButton.addClass("mod-cta");
		if (record.operation) {
			this.editControls.push(
				this.button(
					actions,
					record.operation.status === "committed" ||
						record.operation.status === "prepared"
						? "继续操作"
						: "检查上线状态",
					() =>
						this.operation(
							["committed", "prepared"].includes(record.operation.status)
								? "resume"
								: "verify",
							{ operationId: record.operation.operationId },
						),
				),
			);
		}
		this.message(
			record.sourceMissing
				? "原笔记缺失，已发布文章仍保留。"
				: "预览将在这里更新，发布前会核对文章版本。",
			Boolean(record.sourceMissing),
		);
		this.buttons();
	}
	button(parent, text, action) {
		const button = parent.createEl("button", { text });
		button.addEventListener("click", () => this.plugin.safe(action));
		return button;
	}
	buttons() {
		for (const input of this.editControls || [])
			input.disabled =
				this.control.publishing ||
				this.closed ||
				Boolean(this.plugin.importingData) ||
				Boolean(this.article?.importing);
		if (this.publishButton)
			this.publishButton.disabled =
				!this.control.ready() || Boolean(this.plugin.importingData);
		if (this.browserButton)
			this.browserButton.disabled = !this.frameResult || this.closed;
		if (this.windowButton)
			this.windowButton.disabled = this.closed || this.control.publishing;
		if (this.footerStatus)
			this.footerStatus.setText(
				this.control.publishing
					? "正在处理发布操作…"
					: this.control.ready()
						? "预览已核对，可以发布"
						: this.control.result?.issues?.some((x) => x.severity === "error")
							? "请先处理文章中的问题"
							: "等待最新预览核对",
			);
		if (this.refreshButton) {
			this.refreshButton.disabled =
				this.refreshing || this.control.publishing || this.closed;
			this.refreshButton.setText(this.refreshing ? "正在更新……" : "刷新预览");
		}
	}
	changed() {
		this.dirty = true;
		this.control.invalidate();
		this.buttons();
		if (this.plugin.readContent)
			this.plugin.safe(() => this.article?.refreshImages());
		if (this.control.publishing || this.closed) return;
		this.message(
			this.refreshing
				? "正在生成预览；新修改将在下一轮更新，也可完成后手动刷新。"
				: "内容有修改，将在 1 分钟内自动更新，也可点击「刷新预览」。",
		);
		this.scheduleRefresh();
	}
	scheduleRefresh() {
		if (
			!this.dirty ||
			this.timer ||
			this.closed ||
			this.control.publishing ||
			this.refreshing
		)
			return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.plugin.safe(() => this.refresh());
		}, PREVIEW_INTERVAL);
	}
	async refresh() {
		clearTimeout(this.timer);
		this.timer = null;
		if (this.control.publishing || this.closed || this.refreshing) return;
		const record = this.plugin.record();
		if (!record) return;
		this.refreshing = true;
		this.dirty = false;
		const generation = this.control.begin();
		this.buttons();
		this.message("正在生成预览……");
		try {
			await this.flushDraft();
			const snapshot = await this.plugin.snapshot(record);
			if (this.closed || generation !== this.control.generation) return;
			const result = await this.plugin
				.getClient()
				.request("preview", { snapshot });
			if (this.closed || this.plugin.record()?.id !== record.id) return;
			// Keep the latest completed snapshot visible while typing, but only
			// a matching generation can pass the publication handshake.
			this.control.accept(generation, result);
			if (!record.metadata.published) {
				record.metadata.published = result.metadata.published;
				await this.plugin.save();
				const input = this.contentEl.querySelector('[data-field="published"]');
				if (input) input.value = record.metadata.published;
				this.updateMetadataSummary(record);
			}
			this.issuesEl.empty();
			for (const issue of result.issues) {
				const row = this.issuesEl.createDiv({
					cls: issue.severity === "error" ? "blq-issue blq-error" : "blq-issue",
				});
				setIcon(
					row.createSpan({
						cls: "blq-issue-icon",
						attr: { "aria-hidden": "true" },
					}),
					issue.severity === "error" ? "circle-alert" : "info",
				);
				row.createSpan({
					text: `${issue.severity === "error" ? "需处理" : "提示"} · 第 ${issue.line} 行：${issue.message}`,
				});
				const locate = this.button(row, "查看位置", async () => {
					const file = this.app.vault.getAbstractFileByPath(
						this.plugin.contentPath?.(record) || record.sourcePath,
					);
					if (!file) throw Error("原笔记已移走或删除，请重新关联笔记。");
					const leaf = this.app.workspace.getLeaf(false);
					await leaf.openFile(file);
					leaf.view.editor?.setCursor(Math.max(0, issue.line - 1), 0);
				});
				locate.addClass("blq-text-button");
				locate.setAttribute(
					"aria-label",
					`查看第 ${issue.line} 行：${issue.message}`,
				);
			}
			this.frameResult = result;
			this.frameGeneration = generation;
			if (this.popup) this.showWindowResult();
			else if (generation === this.control.generation)
				this.control.displayed(result.fingerprint);
			if (generation === this.control.generation)
				this.message(
					result.issues.some((x) => x.severity === "error")
						? "预览已生成，请先处理标出的问题。"
						: "预览已生成，可打开窗口查看。浏览器入口也已就绪。",
				);
			if (generation !== this.control.generation)
				this.message(
					"已显示本轮预览；还有新修改，将在 1 分钟内更新，也可手动刷新。",
				);
		} catch (error) {
			if (
				this.closed ||
				generation !== this.control.generation ||
				error.code === "PUBLISHER_CLOSED"
			)
				return;
			this.message(error.message, true);
			this.buttons();
			throw error;
		} finally {
			this.refreshing = false;
			this.buttons();
			if (this.refreshAfterBusy && !this.closed) {
				this.refreshAfterBusy = false;
				this.plugin.safe(() => this.refresh());
			} else this.scheduleRefresh();
		}
	}
	async publish() {
		await this.flushDraft();
		if (!this.control.ready()) throw Error("请等待当前文章预览加载完成。");
		const record = this.plugin.record();
		const snapshot = await this.plugin.snapshot(record);
		if (!this.control.ready()) throw Error("内容已改变，请等待新预览。");
		await this.operation("publish", {
			snapshot,
			fingerprint: this.control.result.fingerprint,
		});
	}
	async operation(command, payload) {
		this.plugin.assertEditable?.();
		if (this.control.publishing) throw Error("已有操作正在进行。");
		await this.flushDraft();
		this.plugin.assertEditable?.();
		if (this.control.publishing) throw Error("已有操作正在进行。");
		const record = this.plugin.record();
		this.control.publishing = true;
		this.buttons();
		try {
			const result = await this.plugin.getClient().request(command, {
				...payload,
				settings: structuredClone(this.plugin.state.settings),
			});
			record.operation = result;
			record.status = result.status;
			if (result.status === "live")
				record.lastPublished = {
					contentFingerprint: result.contentFingerprint,
					commit: result.commit,
					updated: result.updated,
				};
			if (result.status === "unpublished") record.lastPublished = null;
			await this.plugin.save();
			this.control.publishing = false;
			this.render();
			this.message(result.error || labels[result.status]);
			new Notice(result.error || labels[result.status], 8000);
		} finally {
			this.control.publishing = false;
			this.changed();
		}
	}
}
module.exports = { PublisherView, VIEW_TYPE };
