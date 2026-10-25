const {
	ItemView,
	Setting,
	Notice,
	FuzzySuggestModal,
	Modal,
} = require("obsidian");
const { PreviewController } = require("./controller.cjs");
const model = require("./model.cjs");
const VIEW_TYPE = "blqblog-publisher";
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
		this.closed = false;
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
		this.registerDomEvent(window, "message", (event) =>
			this.handlePreviewMessage(event),
		);
		await this.plugin.safe(() => this.plugin.recover());
		this.bind(this.plugin.record());
	}
	async onClose() {
		this.closed = true;
		clearTimeout(this.timer);
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
			this.frameGeneration !== this.control.generation ||
			event.data?.fingerprint !== result.fingerprint
		)
			return;
		if (event.data.type === "blq-preview-scroll") {
			if (Number.isFinite(event.data.position))
				this.scrollPosition = event.data.position;
			return;
		}
		if (event.data.type !== "blq-preview-ready") return;
		this.control.displayed(event.data.fingerprint);
		this.buttons();
		this.message(
			result.issues.some((x) => x.severity === "error")
				? "预览已显示，请先处理上方问题。"
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
		if (record) this.changed();
	}
	message(text, error = false) {
		if (this.statusEl) {
			this.statusEl.setText(text);
			this.statusEl.toggleClass("blq-error", error);
		}
	}
	render() {
		this.control.invalidate();
		const el = this.contentEl;
		el.empty();
		el.addClass("blq-publisher");
		const record = this.plugin.record();
		const header = el.createDiv({ cls: "blq-header" });
		header.createEl("h2", { text: "博客工作台" });
		const tools = header.createDiv({ cls: "blq-actions" });
		this.button(tools, "绑定当前笔记", () =>
			this.plugin.bind(
				this.app.workspace.getActiveFile() || this.plugin.lastMarkdown,
			),
		);
		this.button(tools, "选择笔记", () =>
			new FilePicker(
				this.app,
				(f) => f.extension === "md",
				(file) => this.plugin.safe(() => this.plugin.bind(file)),
			).open(),
		);
		const records = header.createEl("select", {
			attr: { "aria-label": "发布记录" },
		});
		records.createEl("option", { text: "选择发布记录", value: "" });
		for (const item of this.plugin.state.records)
			records.createEl("option", {
				text: `${item.metadata.title} · ${item.sourceMissing ? "原笔记缺失" : labels[item.status] || item.status}`,
				value: item.id,
			});
		records.value = record?.id || "";
		records.addEventListener("change", () =>
			this.plugin.safe(async () => {
				if (!records.value) return;
				this.plugin.state.settings.lastRecordId = records.value;
				await this.plugin.save();
				this.bind(this.plugin.record());
			}),
		);
		this.statusEl = header.createEl("p", {
			cls: "blq-status",
			attr: { role: "status" },
		});
		if (!record) {
			this.message("选择一篇笔记，开始预览。");
			return;
		}
		this.control.id = record.id;
		this.control.missing = record.sourceMissing;
		header.createEl("p", {
			text: `当前固定预览：${record.sourcePath}`,
			cls: "blq-source",
		});
		if (record.sourceMissing) {
			this.message("原笔记缺失，已发布文章仍保留。", true);
			this.button(header, "重新关联笔记", () =>
				new FilePicker(
					this.app,
					(f) => f.extension === "md",
					(file) =>
						this.plugin.safe(async () => {
							model.relinkSource(this.plugin.state, record.id, file.path);
							await this.plugin.save();
							this.bind(record);
						}),
				).open(),
			);
		}
		const fields = el.createEl("details", { cls: "blq-fields" });
		fields.open = true;
		fields.createEl("summary", { text: "发布信息" });
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
			if (key === "published") input.setAttribute("max", model.today());
			input.addEventListener("input", () => {
				model.updateMetadata(record, {
					[key]: key === "tags" ? input.value.split(/[,，\n]/) : input.value,
				});
				this.plugin.safe(() => this.plugin.save());
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
		this.button(cover, "选择封面", () =>
			new FilePicker(
				this.app,
				(f) => /^(jpg|jpeg|png|webp|gif|avif)$/i.test(f.extension),
				(file) =>
					this.plugin.safe(async () => {
						model.updateMetadata(record, { cover: file.path });
						await this.plugin.save();
						this.render();
						this.changed();
					}),
			).open(),
		);
		this.button(cover, "清除", async () => {
			model.updateMetadata(record, { cover: "" });
			await this.plugin.save();
			this.render();
			this.changed();
		});
		const bar = el.createDiv({ cls: "blq-actions" });
		this.button(bar, "刷新预览", () => this.refresh());
		this.button(bar, "浏览器打开", () => {
			if (this.control.result) window.open(this.control.result.url, "_blank");
		});
		this.publishButton = this.button(
			bar,
			record.lastPublished ? "更新文章" : "发布文章",
			() => this.publish(),
		);
		this.publishButton.addClass("mod-cta");
		if (record.lastPublished && record.status !== "unpublished")
			this.button(bar, "下架", () =>
				new Confirm(
					this.app,
					"下架这篇博客文章",
					`将从网站移除《${record.metadata.title}》。原笔记、发布信息和 Git 历史保留，可重新发布。`,
					() =>
						this.plugin.safe(() =>
							this.operation("unpublish", { id: record.id }),
						),
				).open(),
			);
		if (record.operation) {
			this.button(
				bar,
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
			);
		}
		this.issuesEl = el.createDiv({ cls: "blq-issues" });
		this.previewEl = el.createDiv({ cls: "blq-preview" });
		this.message(labels[record.status] || "本地草稿");
		this.buttons();
	}
	button(parent, text, action) {
		const button = parent.createEl("button", { text });
		button.addEventListener("click", () => this.plugin.safe(action));
		return button;
	}
	buttons() {
		if (this.publishButton) this.publishButton.disabled = !this.control.ready();
	}
	changed() {
		this.control.invalidate();
		this.buttons();
		clearTimeout(this.timer);
		if (this.control.publishing || this.closed) return;
		this.message("内容已改变，正在准备预览……");
		this.timer = setTimeout(() => this.plugin.safe(() => this.refresh()), 900);
	}
	async refresh() {
		clearTimeout(this.timer);
		if (this.control.publishing || this.closed) return;
		const record = this.plugin.record();
		if (!record) return;
		const generation = this.control.begin();
		this.buttons();
		this.message("正在生成预览……");
		try {
			const snapshot = await this.plugin.snapshot(record);
			const result = await this.plugin
				.getClient()
				.request("preview", { snapshot });
			if (this.closed || !this.control.accept(generation, result)) return;
			if (!record.metadata.published) {
				record.metadata.published = result.metadata.published;
				await this.plugin.save();
				const input = this.contentEl.querySelector('[data-field="published"]');
				if (input) input.value = record.metadata.published;
			}
			this.issuesEl.empty();
			for (const issue of result.issues) {
				const row = this.issuesEl.createEl("p", {
					text: `${issue.severity === "error" ? "需处理" : "提示"} · 第 ${issue.line} 行：${issue.message}`,
					cls: issue.severity === "error" ? "blq-error" : "",
				});
				row.addEventListener("click", () =>
					this.plugin.safe(async () => {
						const file = this.app.vault.getAbstractFileByPath(
							record.sourcePath,
						);
						const leaf = this.app.workspace.getLeaf(false);
						await leaf.openFile(file);
						leaf.view.editor?.setCursor(Math.max(0, issue.line - 1), 0);
					}),
				);
			}
			this.previewEl.empty();
			const frame = this.previewEl.createEl("iframe", {
				cls: "blq-frame",
				attr: { title: "文章的真实博客预览" },
			});
			this.frame = frame;
			this.frameResult = result;
			this.frameGeneration = generation;
			frame.addEventListener("load", () => {
				if (this.closed || generation !== this.control.generation) return;
				frame.contentWindow.postMessage(
					{ type: "blq-preview-request" },
					new URL(result.url).origin,
				);
			});
			frame.src = result.url;
		} catch (error) {
			if (generation === this.control.generation) {
				this.message(error.message, true);
				this.buttons();
			}
			throw error;
		}
	}
	async publish() {
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
