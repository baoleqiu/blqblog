const { ItemView } = require("obsidian");
const PREVIEW_VIEW_TYPE = "blqblog-preview-window";
class PreviewWindowView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.phone = false;
	}
	getViewType() {
		return PREVIEW_VIEW_TYPE;
	}
	getDisplayText() {
		return "博客窗口预览";
	}
	getIcon() {
		return "monitor";
	}
	async onOpen() {
		this.render();
		this.owner = this.plugin.view();
		if (this.owner) {
			this.owner.popup = this;
			this.owner.showWindowResult();
		} else this.setStatus("请先打开博客工作台并选择文章。");
	}
	render() {
		this.contentEl.empty();
		this.contentEl.addClass("blq-preview-window");
		const toolbar = this.contentEl.createDiv({ cls: "blq-window-toolbar" });
		const action = (text, fn) => {
			const b = toolbar.createEl("button", { text });
			b.addEventListener("click", () => this.plugin.safe(fn));
			return b;
		};
		this.desktopButton = action("电脑", () => this.resize(false));
		this.phoneButton = action("手机", () => this.resize(true));
		action("刷新预览", () => this.owner?.refresh());
		this.status = toolbar.createEl("span", {
			cls: "blq-window-status",
			attr: { role: "status" },
		});
		action("在浏览器打开", () => {
			if (this.result) require("electron").shell.openExternal(this.result.url);
		});
		this.stage = this.contentEl.createDiv({ cls: "blq-window-stage" });
		this.setStatus("正在准备预览…");
	}
	receive(event) {
		this.owner?.handlePreviewMessage(event);
	}
	bindMessageWindow() {
		const win = this.frame?.ownerDocument.defaultView;
		if (!win || this.messageWindows?.has(win)) return;
		this.messageWindows ||= new Set();
		this.messageWindows.add(win);
		this.registerDomEvent(win, "message", (event) => this.receive(event));
	}
	resize(phone) {
		this.phone = phone;
		if (this.frame) this.frame.style.maxWidth = phone ? "390px" : "100%";
		this.phoneButton?.toggleClass("is-active", phone);
		this.desktopButton?.toggleClass("is-active", !phone);
	}
	setStatus(text) {
		this.status?.setText(text);
	}
	update(result, generation) {
		this.result = result;
		this.generation = generation;
		if (!this.frame) {
			this.frame = this.stage.createEl("iframe", {
				cls: "blq-window-frame",
				attr: { title: "文章的真实博客预览" },
			});
			this.frame.addEventListener("load", () => {
				this.bindMessageWindow();
				if (this.result)
					this.frame.contentWindow.postMessage(
						{ type: "blq-preview-request" },
						new URL(this.result.url).origin,
					);
			});
		}
		this.resize(this.phone);
		if (this.frame.src !== result.url) this.frame.src = result.url;
		this.setStatus("正在载入最新文章…");
		return this.frame;
	}
	clear() {
		this.result = null;
		this.frame = null;
		this.stage?.empty();
		this.setStatus("正在准备文章预览…");
	}
	async onClose() {
		const owner = this.owner;
		this.owner = null;
		if (owner?.popup === this) {
			owner.popup = null;
			owner.frame = null;
			if (
				owner.frameGeneration === owner.control.generation &&
				owner.frameResult
			)
				owner.control.displayed(owner.frameResult.fingerprint);
			owner.buttons();
		}
	}
}
module.exports = { PreviewWindowView, PREVIEW_VIEW_TYPE };
