const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const rows = [];
const modals = [];
class Setting {
	constructor() {
		this.buttons = [];
		rows.push(this);
	}
	setName(name) {
		this.name = name;
		return this;
	}
	setDesc() {
		return this;
	}
	addText(fn) {
		const field = {
			setPlaceholder: () => field,
			setValue: () => field,
			onChange: () => field,
		};
		fn(field);
		return this;
	}
	addToggle(fn) {
		const field = { setValue: () => field, onChange: () => field };
		fn(field);
		return this;
	}
	addButton(fn) {
		const button = {
			setButtonText: (text) => {
				button.text = text;
				return button;
			},
			onClick: (handler) => {
				button.click = handler;
				return button;
			},
		};
		fn(button);
		this.buttons.push(button);
		return this;
	}
}
const originalLoad = Module._load;
Module._load = function (name, ...args) {
	if (name === "obsidian")
		return {
			Setting,
			PluginSettingTab: class {
				constructor(app) {
					this.app = app;
					this.containerEl = { empty() {}, createEl() {} };
				}
			},
			Modal: class {
				constructor(app) {
					this.app = app;
				}
				open() {
					modals.push(this);
				}
			},
			Notice: class {},
		};
	return originalLoad.call(this, name, ...args);
};
const {
	PublisherSettings,
} = require("../../integrations/obsidian-blog-publisher/src/settings.cjs");
Module._load = originalLoad;
function setup() {
	rows.length = 0;
	modals.length = 0;
	const current = {
		version: 1,
		settings: { vaultRoot: "E:/current-vault", repoPath: "E:/current-blog" },
		records: [],
	};
	const incoming = {
		version: 1,
		settings: { vaultRoot: "D:/old-vault", repoPath: "D:/old-blog" },
		records: [{ id: "incoming" }],
	};
	let publishing = false;
	let rendered = 0;
	let pending = "unsaved draft body";
	let saved = "";
	const imported = [];
	const view = {
		flushDraft: async () => {
			saved = pending;
		},
		render: () => {
			rendered++;
			pending = "rerendered";
		},
	};
	const plugin = {
		state: current,
		view: () => view,
		assertEditable: () => {
			if (publishing) throw Error("发布正在进行");
		},
		store: {
			import: async (text) => {
				imported.push({ value: JSON.parse(text), saved });
				return JSON.parse(text);
			},
		},
	};
	const settings = new PublisherSettings(
		{ vault: { adapter: { getBasePath: () => "E:/current-vault" } } },
		plugin,
	);
	settings.display();
	function submit(name) {
		rows.find((row) => row.name === name).buttons[0].click();
		return modals.at(-1).onSave(JSON.stringify(incoming));
	}
	return {
		plugin,
		current,
		incoming,
		view,
		imported,
		submit,
		lock: () => {
			publishing = true;
		},
		rendered: () => rendered,
		pending: () => pending,
	};
}
for (const entry of ["导入发布数据", "迁移备份到当前电脑"]) {
	test(`${entry}: publication blocks import before draft flushing or state replacement`, async () => {
		const h = setup();
		h.lock();
		await assert.rejects(h.submit(entry), /发布/);
		assert.equal(h.plugin.state, h.current);
		assert.equal(h.imported.length, 0);
		assert.equal(h.rendered(), 0);
		assert.equal(h.pending(), "unsaved draft body");
	});
	test(`${entry}: draft save conflicts stop import and retain the existing editor`, async () => {
		const h = setup();
		h.view.flushDraft = async () => {
			throw Error("保存冲突");
		};
		await assert.rejects(h.submit(entry), /冲突/);
		assert.equal(h.plugin.state, h.current);
		assert.equal(h.imported.length, 0);
		assert.equal(h.rendered(), 0);
		assert.equal(h.pending(), "unsaved draft body");
	});
	test(`${entry}: a publication starting while drafts flush prevents import`, async () => {
		const h = setup();
		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		h.view.flushDraft = () => gate;
		const rejected = assert.rejects(h.submit(entry), /发布/);
		h.lock();
		release();
		await rejected;
		assert.equal(h.imported.length, 0);
		assert.equal(h.plugin.state, h.current);
		assert.equal(h.rendered(), 0);
	});
	test(`${entry}: pending draft body is saved before import and replacement`, async () => {
		const h = setup();
		await h.submit(entry);
		assert.equal(h.imported[0].saved, "unsaved draft body");
		assert.deepEqual(h.plugin.state.records, [{ id: "incoming" }]);
		assert.equal(h.rendered(), 1);
		assert.deepEqual(
			h.imported[0].value.settings,
			entry === "迁移备份到当前电脑" ? h.current.settings : h.incoming.settings,
		);
	});
}
