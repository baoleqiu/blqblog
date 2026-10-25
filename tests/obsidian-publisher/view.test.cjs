const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
class Element {
	constructor(tag = "div") {
		this.tag = tag;
		this.children = [];
		this.attrs = {};
		this.disabled = false;
	}
	createEl(tag, info = {}) {
		const el = new Element(tag);
		el.attrs = info.attr || {};
		el.textContent = info.text || "";
		this.children.push(el);
		return el;
	}
	createDiv(info) {
		return this.createEl("div", info);
	}
	createSpan(info) {
		return this.createEl("span", info);
	}
	empty() {
		this.children = [];
	}
	addClass() {}
	toggleClass() {}
	setText(text) {
		this.textContent = text;
	}
	addEventListener() {}
	setAttribute(k, v) {
		this.attrs[k] = v;
	}
	querySelectorAll(selector) {
		return this.children.flatMap((c) => [
			...(selector === "[data-field]" && c.attrs["data-field"] ? [c] : []),
			...c.querySelectorAll(selector),
		]);
	}
}
const originalLoad = Module._load;
const notices = [];
Module._load = function (name, ...args) {
	if (name === "obsidian")
		return {
			ItemView: class {
				constructor() {
					this.contentEl = new Element();
				}
			},
			Notice: class {
				constructor(message) {
					notices.push(message);
				}
			},
			Plugin: class {},
			PluginSettingTab: class {},
			Setting: class {},
			FuzzySuggestModal: class {},
			Modal: class {},
		};
	return originalLoad.call(this, name, ...args);
};
const {
	PublisherView,
} = require("../../integrations/obsidian-blog-publisher/src/view.cjs");
const BlogPublisher = require("../../integrations/obsidian-blog-publisher/src/main.cjs");
Module._load = originalLoad;
test("normal client cancellation does not overwrite a reopened panel or show a notice", async () => {
	const plugin = new BlogPublisher();
	const messages = [];
	plugin.view = () => ({ message: (text) => messages.push(text) });
	notices.length = 0;
	await plugin.safe(async () => {
		throw Object.assign(Error("发布面板已关闭。"), {
			code: "PUBLISHER_CLOSED",
		});
	});
	assert.deepEqual(notices, []);
	assert.deepEqual(messages, []);
	await plugin.safe(async () => {
		throw Error("真实预览错误");
	});
	assert.deepEqual(notices, ["真实预览错误"]);
	assert.deepEqual(messages, ["真实预览错误"]);
});
test("closing while reading the note does not start another preview worker", async () => {
	let finishSnapshot;
	let requests = 0;
	const plugin = {
		record: () => ({ id: "note" }),
		snapshot: () =>
			new Promise((resolve) => {
				finishSnapshot = resolve;
			}),
		getClient: () => ({
			request: async () => {
				requests++;
				return {};
			},
		}),
		closeClient: async () => {},
	};
	const view = new PublisherView({}, plugin);
	const refresh = view.refresh();
	await view.onClose();
	finishSnapshot({});
	await refresh;
	assert.equal(requests, 0);
});
test("superseded preview errors stay silent while current preview errors propagate", async () => {
	let rejectPreview;
	const plugin = {
		record: () => ({ id: "note" }),
		snapshot: async () => ({}),
		getClient: () => ({
			request: () =>
				new Promise((_, reject) => {
					rejectPreview = reject;
				}),
		}),
	};
	const view = new PublisherView({}, plugin);
	const oldRefresh = view.refresh();
	await Promise.resolve();
	view.control.invalidate();
	rejectPreview(Error("旧预览错误"));
	await assert.doesNotReject(oldRefresh);
	const currentRefresh = view.refresh();
	await Promise.resolve();
	rejectPreview(Error("当前预览错误"));
	await assert.rejects(currentRefresh, /当前预览错误/);
});
test("metadata inputs remain editable after actual view operation completion", async (t) => {
	const record = {
		id: "test-article-1234",
		sourcePath: "note.md",
		metadata: { title: "Title", tags: [] },
		status: "pushed",
	};
	const plugin = {
		state: { settings: {}, records: [record] },
		record: () => record,
		save: async () => {},
		safe: async (fn) => fn(),
		getClient: () => ({
			request: async () => ({
				status: "live",
				operationId: "test-operation-1",
				contentFingerprint: "fp",
				commit: "abc",
			}),
		}),
	};
	const view = new PublisherView({}, plugin);
	view.app = {};
	view.control.bind(record.id);
	t.after(() => clearTimeout(view.timer));
	view.render();
	await view.operation("verify", {});
	assert.equal(view.control.publishing, false);
	const fields = view.contentEl.querySelectorAll("[data-field]");
	assert.equal(fields.length, 5);
	assert.ok(fields.every((x) => !x.disabled));
});
