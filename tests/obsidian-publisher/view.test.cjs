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
function previewHarness() {
	const record = {
		id: "preview-note",
		sourcePath: "note.md",
		metadata: { title: "Title", tags: [], published: "2026-01-01" },
		status: "draft",
	};
	const requests = [];
	const plugin = {
		state: { settings: {}, records: [record] },
		record: () => record,
		safe: async (fn) => fn(),
		save: async () => {},
		closeClient: async () => {},
		snapshot: async () => ({ markdown: "current" }),
		getClient: () => ({
			request: () =>
				new Promise((resolve) => {
					requests.push(resolve);
				}),
		}),
	};
	const view = new PublisherView({}, plugin);
	view.control.bind(record.id);
	view.render();
	const result = {
		fingerprint: "fp",
		url: "http://localhost/post/",
		issues: [],
		metadata: record.metadata,
	};
	return { view, requests, result, plugin };
}
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
test("typing waits one minute and further edits do not postpone or multiply automatic previews", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view, requests, result } = previewHarness();
	t.after(() => view.onClose());
	view.changed();
	t.mock.timers.tick(30000);
	await settle();
	assert.equal(requests.length, 0);
	view.changed();
	t.mock.timers.tick(29999);
	await settle();
	assert.equal(requests.length, 0);
	t.mock.timers.tick(1);
	await settle();
	assert.equal(requests.length, 1);
	requests[0](result);
	await settle();
	t.mock.timers.tick(180000);
	await settle();
	assert.equal(requests.length, 1, "unchanged content needs no rebuild");
});
test("manual refresh runs immediately and cancels the pending automatic refresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view, requests, result } = previewHarness();
	t.after(() => view.onClose());
	view.changed();
	t.mock.timers.tick(10000);
	const pending = view.refresh();
	await settle();
	assert.equal(requests.length, 1);
	requests[0](result);
	await pending;
	t.mock.timers.tick(120000);
	await settle();
	assert.equal(requests.length, 1);
});
test("editing during generation does not queue builds and shows a snapshot without enabling stale publication", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view, requests, result } = previewHarness();
	t.after(() => view.onClose());
	const pending = view.refresh();
	await settle();
	view.changed();
	void view.refresh();
	t.mock.timers.tick(60000);
	await settle();
	assert.equal(requests.length, 1);
	requests[0](result);
	await pending;
	assert.equal(view.frame.src, result.url);
	assert.equal(view.control.ready(), false);
	assert.equal(view.publishButton.disabled, true);
	t.mock.timers.tick(60000);
	await settle();
	assert.equal(
		requests.length,
		2,
		"next cycle picks up edits made during generation",
	);
	requests[1](result);
	await settle();
});
test("closing a dirty panel cancels its automatic preview timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view, requests } = previewHarness();
	view.changed();
	await view.onClose();
	t.mock.timers.tick(60000);
	await settle();
	assert.equal(requests.length, 0);
});
test("reading an older preview preserves scroll position but cannot certify it for publication", () => {
	const { view, result } = previewHarness();
	const source = {};
	view.frame = { contentWindow: source };
	view.frameResult = result;
	view.frameGeneration = view.control.generation - 1;
	const event = {
		source,
		origin: "http://localhost",
		data: { type: "blq-preview-scroll", fingerprint: "fp", position: 420 },
	};
	view.handlePreviewMessage(event);
	assert.equal(view.scrollPosition, 420);
	view.handlePreviewMessage({
		...event,
		data: { type: "blq-preview-ready", fingerprint: "fp" },
	});
	assert.equal(view.control.ready(), false);
});
test("binding a note previews immediately and switching during generation runs only the new note next", async (t) => {
	const { view, requests, result, plugin } = previewHarness();
	t.after(() => view.onClose());
	view.bind(plugin.record());
	await settle();
	assert.equal(requests.length, 1);
	const next = { ...plugin.record(), id: "next-note", sourcePath: "next.md" };
	plugin.record = () => next;
	view.bind(next);
	await settle();
	assert.equal(requests.length, 1);
	requests[0](result);
	await settle();
	assert.equal(requests.length, 2);
	assert.equal(
		view.frame,
		null,
		"old note must not appear in the new note preview",
	);
	requests[1]({ ...result, url: "http://localhost/next/" });
	await settle();
	assert.equal(view.frame.src, "http://localhost/next/");
});
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
