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
Module._load = function (name, ...args) {
	if (name === "obsidian")
		return {
			ItemView: class {
				constructor() {
					this.contentEl = new Element();
				}
			},
			Notice: class {},
			Setting: class {},
			FuzzySuggestModal: class {},
			Modal: class {},
		};
	return originalLoad.call(this, name, ...args);
};
const {
	PublisherView,
} = require("../../integrations/obsidian-blog-publisher/src/view.cjs");
Module._load = originalLoad;
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
