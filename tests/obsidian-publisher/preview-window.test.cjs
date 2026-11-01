const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
class El {
	constructor() {
		this.children = [];
		this.events = {};
		this.style = {};
	}
	createEl(tag, props = {}) {
		const el = new El();
		el.tag = tag;
		el.text = props.text;
		this.children.push(el);
		return el;
	}
	createDiv(props) {
		return this.createEl("div", props);
	}
	empty() {
		this.children = [];
	}
	addClass() {}
	toggleClass() {}
	setText(t) {
		this.text = t;
	}
	addEventListener(k, fn) {
		this.events[k] = fn;
	}
}
const load = Module._load;
Module._load = function (name, ...args) {
	if (name === "obsidian")
		return {
			ItemView: class {
				constructor() {
					this.contentEl = new El();
				}
			},
			setIcon() {},
		};
	return load.call(this, name, ...args);
};
let PreviewWindowView;
try {
	({
		PreviewWindowView,
	} = require("../../integrations/obsidian-blog-publisher/src/preview-window.cjs"));
} finally {
	Module._load = load;
}
test("preview window reuses its frame, keeps phone width and delegates only to its owner", () => {
	const events = [];
	const owner = {
		plugin: { record: () => ({ metadata: { title: "Test" } }) },
		handlePreviewMessage: (event) => events.push(event),
		buttons() {},
		message() {},
	};
	const view = new PreviewWindowView({}, { view: () => owner });
	view.render();
	view.owner = owner;
	view.phone = true;
	const first = view.update(
		{ url: "http://127.0.0.1:4321/a", fingerprint: "one" },
		1,
	);
	const second = view.update(
		{ url: "http://127.0.0.1:4321/a?publisher=two", fingerprint: "two" },
		2,
	);
	assert.equal(first, second);
	assert.equal(view.frame.src, "http://127.0.0.1:4321/a?publisher=two");
	assert.equal(view.frame.style.maxWidth, "390px");
	view.receive({ data: "message" });
	assert.equal(events.length, 1);
	view.owner = null;
	view.receive({ data: "old" });
	assert.equal(events.length, 1);
});
