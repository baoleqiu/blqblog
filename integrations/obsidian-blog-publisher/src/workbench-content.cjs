class DraftBuffer {
	constructor(plugin, record, base) {
		this.plugin = plugin;
		this.record = record;
		this.base = base;
		this.queue = Promise.resolve();
		this.error = null;
	}
	save(text) {
		const write = async () => {
			if (this.error) throw this.error;
			try {
				await this.plugin.saveDraft(this.record, text, this.base);
				this.base = text;
			} catch (error) {
				this.error = error;
				throw error;
			}
		};
		this.queue = this.queue.catch(() => {}).then(write);
		return this.queue;
	}
}
class ArticleContent {
	constructor(view, parent, record) {
		this.view = view;
		this.plugin = view.plugin;
		this.parent = parent;
		this.record = record;
		this.tab = record.contentMode === "draft" ? "text" : "images";
		this.text = "";
		this.disposed = false;
		this.controls = [];
		this.ready = this.load();
	}
	async load() {
		if (!this.plugin.readContent) return;
		try {
			const text = await this.plugin.readContent(this.record);
			if (this.disposed) return;
			this.text = text;
			this.buffer = new DraftBuffer(this.plugin, this.record, text);
			this.render();
		} catch (error) {
			if (!this.disposed)
				this.parent.createEl("p", { text: error.message, cls: "blq-error" });
		}
	}
	async flush() {
		clearTimeout(this.saveTimer);
		await this.importQueue;
		await this.ready;
		if (!this.buffer || this.record.contentMode !== "draft") return;
		if (this.input) this.text = this.input.value;
		await this.buffer.queue;
		if (this.buffer.error) throw this.buffer.error;
		if (this.text !== this.buffer.base) {
			this.saveStatus?.setText("正在保存…");
			try {
				await this.buffer.save(this.text);
				this.saveStatus?.setText("已保存");
			} catch (error) {
				this.saveStatus?.setText("保存冲突，正文仍保留在编辑框中");
				throw error;
			}
		}
	}
	dispose() {
		this.disposed = true;
		clearTimeout(this.saveTimer);
		this.view.editControls = this.view.editControls.filter(
			(el) => !this.controls.includes(el),
		);
	}
	track(...controls) {
		this.controls.push(...controls);
		this.view.editControls.push(...controls);
	}
	button(parent, title, fn) {
		const b = this.view.button(parent, title, fn);
		this.track(b);
		return b;
	}
	render() {
		this.view.editControls = this.view.editControls.filter(
			(el) => !this.controls.includes(el),
		);
		this.controls = [];
		this.parent.empty();
		this.input = null;
		const tabs = this.parent.createDiv({ cls: "blq-content-tabs" });
		if (this.record.contentMode === "draft")
			this.button(tabs, "正文", async () => {
				await this.flush();
				this.tab = "text";
				this.render();
			});
		this.button(tabs, "图片", async () => {
			await this.flush();
			this.tab = "images";
			this.render();
		});
		if (this.record.contentMode === "draft") {
			const external = this.button(tabs, "用 VS Code 编辑", async () => {
				await this.flush();
				await this.plugin.openDraftExternal(this.record, true);
			});
			external.addClass("blq-external-editor");
			this.button(tabs, "系统编辑器", async () => {
				await this.flush();
				await this.plugin.openDraftExternal(this.record, false);
			});
		}
		if (this.tab === "text") this.renderText();
		else this.renderImages();
		this.view.buttons();
	}
	renderText() {
		const tools = this.parent.createDiv({ cls: "blq-editor-tools" });
		this.button(tools, "粗体", () => this.insert("**文字**"));
		this.button(tools, "标题", () => this.insert("\n## 标题\n"));
		this.button(tools, "插入图片", () => this.picker.click());
		tools.createSpan({ text: "可粘贴或拖入图片", cls: "blq-muted" });
		this.picker = tools.createEl("input", {
			attr: {
				type: "file",
				accept: "image/png,image/jpeg,image/webp,image/gif,image/avif",
				"aria-label": "选择图片文件",
				hidden: "",
			},
		});
		this.picker.addEventListener("change", () =>
			this.plugin.safe(() =>
				this.insertImages(Array.from(this.picker.files || [])),
			),
		);
		this.input = this.parent.createEl("textarea", {
			cls: "blq-draft-editor",
			attr: { "aria-label": "博客稿 Markdown 正文", spellcheck: "false" },
		});
		this.input.value = this.text;
		this.track(this.input, this.picker);
		this.input.addEventListener("input", () => this.edited());
		this.input.addEventListener("paste", (event) => {
			const files = Array.from(event.clipboardData?.files || []).filter(
				(file) => file.type.startsWith("image/"),
			);
			if (files.length) {
				event.preventDefault();
				this.plugin.safe(() => this.insertImages(files));
			}
		});
		this.input.addEventListener("dragover", (event) => {
			if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
		});
		this.input.addEventListener("drop", (event) => {
			const files = Array.from(event.dataTransfer?.files || []).filter((file) =>
				file.type.startsWith("image/"),
			);
			if (files.length) {
				event.preventDefault();
				this.plugin.safe(() => this.insertImages(files));
			}
		});
		const foot = this.parent.createDiv({ cls: "blq-editor-foot" });
		foot.createSpan({ text: this.record.draftPath });
		this.saveStatus = foot.createSpan({
			text: this.buffer.error ? "保存冲突" : "已保存",
		});
		this.button(foot, "重新读取文件", async () => {
			if (this.text !== this.buffer.base || this.buffer.error)
				await this.plugin.saveDraftRecovery(this.record, this.text);
			await this.load();
		});
	}
	edited() {
		if (this.view.control.publishing) return;
		this.text = this.input.value;
		this.saveStatus?.setText("有未保存修改");
		this.view.changed();
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(
			() => this.plugin.safe(() => this.flush()),
			600,
		);
	}
	insert(value) {
		if (!this.input || this.view.control.publishing || this.disposed) return;
		const start = this.input.selectionStart ?? this.input.value.length;
		const end = this.input.selectionEnd ?? start;
		this.input.value =
			this.input.value.slice(0, start) + value + this.input.value.slice(end);
		this.input.selectionStart = this.input.selectionEnd = start + value.length;
		this.input.focus();
		this.edited();
	}
	async insertImages(files) {
		const editor = this.input;
		if (!editor || this.view.control.publishing || this.importing) return;
		let start = editor.selectionStart ?? editor.value.length;
		let end = editor.selectionEnd ?? start;
		this.importing = true;
		this.view.buttons();
		this.importQueue = (async () => {
			for (const file of files) {
				const link = await this.plugin.insertDraftImage(this.record, file);
				const insertion = `\n${link}\n`;
				editor.value =
					editor.value.slice(0, start) + insertion + editor.value.slice(end);
				start += insertion.length;
				end = start;
				editor.selectionStart = editor.selectionEnd = start;
				this.text = editor.value;
				this.view.changed();
			}
		})();
		try {
			await this.importQueue;
			this.importQueue = null;
			await this.flush();
		} finally {
			this.importing = false;
			this.view.buttons();
		}
	}
	async refreshImages() {
		if (
			this.disposed ||
			(this.input &&
				(this.input.value !== this.buffer.base || this.buffer.error))
		)
			return;
		const text = await this.plugin.readContent?.(this.record);
		if (this.disposed || typeof text !== "string") return;
		if (this.input) {
			if (this.input.value === this.buffer.base) {
				this.input.value = text;
				this.text = text;
				this.buffer.base = text;
			}
			return;
		}
		this.text = text;
		this.buffer.base = text;
		this.render();
	}
	imageUrl(item) {
		if (/^https?:\/\//i.test(item.target)) return item.target;
		const file = this.plugin.imageFile?.(this.record, item);
		return file ? this.view.app.vault.getResourcePath(file) : "";
	}
	renderImages() {
		const { listImages, normalizeLayout } = require("./image-layout.cjs");
		const items = listImages(this.text).filter(
			(item) => !/\.mp4(?:$|[?#])/i.test(item.target),
		);
		this.parent.createEl("p", {
			text: `文章图片 · ${items.length} 处引用`,
			cls: "blq-section-title",
		});
		this.parent.createEl("p", {
			text: "排版仅用于博客；每一处图片分别设置。",
			cls: "blq-muted",
		});
		if (!items.length) {
			this.parent.createEl("p", {
				text: "正文中还没有图片。可在原笔记或博客稿中插入图片。",
			});
			return;
		}
		const split = this.parent.createDiv({ cls: "blq-image-panel" });
		const list = split.createDiv({ cls: "blq-image-list" });
		const selected = items.find((x) => x.key === this.selected) || items[0];
		this.selected = selected.key;
		for (const [index, item] of items.entries()) {
			const choose = this.button(list, "", () => {
				this.selected = item.key;
				this.render();
			});
			choose.addClass("blq-image-choice");
			choose.toggleClass("is-selected", item.key === selected.key);
			const url = this.imageUrl(item);
			if (url)
				choose.createEl("img", {
					attr: { src: url, alt: "", loading: "lazy" },
				});
			choose.createSpan({
				text: `${index + 1}. ${item.alt || item.target.split("/").pop()}`,
			});
			choose.setAttribute(
				"aria-label",
				`第 ${index + 1} 处图片：${item.alt || item.target}`,
			);
		}
		const settings = split.createDiv({ cls: "blq-image-settings" });
		const url = this.imageUrl(selected);
		if (url)
			settings.createEl("img", {
				cls: "blq-selected-image",
				attr: { src: url, alt: selected.alt || "选中的图片" },
			});
		else
			settings.createEl("p", {
				text: "图片未找到，请检查引用。",
				cls: "blq-error",
			});
		settings.createEl("p", {
			text: `第 ${items.indexOf(selected) + 1} 处 · 第 ${selected.line} 行`,
			cls: "blq-muted",
		});
		const current = this.record.imageLayouts?.[selected.key] || {
			width: 100,
			unit: "%",
			align: "center",
			caption: "",
		};
		const widthLabel = settings.createEl("label", {
			text: "图片宽度",
			cls: "blq-field",
		});
		const widthRow = widthLabel.createDiv({ cls: "blq-width-row" });
		const width = widthRow.createEl("input", {
			attr: {
				type: "number",
				min: "1",
				max: current.unit === "%" ? "100" : "10000",
				"aria-label": "图片宽度",
			},
		});
		width.value = String(current.width);
		const unit = widthRow.createEl("select", {
			attr: { "aria-label": "宽度单位" },
		});
		for (const u of ["%", "px"]) unit.createEl("option", { text: u, value: u });
		unit.value = current.unit;
		const aligns = settings.createDiv({ cls: "blq-alignment" });
		let align = current.align;
		for (const [value, label] of [
			["left", "左对齐"],
			["center", "居中"],
			["right", "右对齐"],
		]) {
			const b = this.button(aligns, label, async () => {
				align = value;
				await save();
				this.render();
			});
			b.toggleClass("is-selected", value === align);
		}
		const captionLabel = settings.createEl("label", {
			text: "图片说明",
			cls: "blq-field",
		});
		const caption = captionLabel.createEl("input", {
			attr: { type: "text", maxlength: "2000" },
		});
		caption.value = current.caption;
		this.track(width, unit, caption);
		const save = async () => {
			if (this.disposed || this.view.control.publishing) return;
			const layout = normalizeLayout({
				width: Number(width.value),
				unit: unit.value,
				align,
				caption: caption.value,
				occurrenceCount: items.filter(
					(item) =>
						item.key.replace(/-\d+$/, "") === selected.key.replace(/-\d+$/, ""),
				).length,
			});
			this.record.imageLayouts ||= {};
			this.record.imageLayouts[selected.key] = layout;
			this.view.changed();
			await this.plugin.save();
		};
		for (const input of [width, unit, caption])
			input.addEventListener("change", () => this.plugin.safe(save));
		unit.addEventListener("change", () => {
			width.max = unit.value === "%" ? "100" : "10000";
		});
		this.button(settings, "保存图片设置", save);
		this.button(settings, "恢复原始排版", async () => {
			delete this.record.imageLayouts?.[selected.key];
			await this.plugin.save();
			this.view.changed();
			this.render();
		});
	}
}
module.exports = { DraftBuffer, ArticleContent };
