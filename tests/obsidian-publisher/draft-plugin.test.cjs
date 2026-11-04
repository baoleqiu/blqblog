const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
class TFile {
	constructor(name, text = "") {
		this.path = name;
		this.basename = path.posix.basename(name).replace(/\.[^.]+$/, "");
		this.extension = name.split(".").pop();
		this.text = text;
	}
}
class MarkdownView {}
const originalLoad = Module._load;
Module._load = function (name, ...args) {
	if (name === "obsidian") return { TFile, MarkdownView, Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, Setting: class {}, FuzzySuggestModal: class {}, Modal: class {}, Menu: class {} };
	return originalLoad.call(this, name, ...args);
};
const BlogPublisher = require("../../integrations/obsidian-blog-publisher/src/main.cjs");
Module._load = originalLoad;
const model = require("../../integrations/obsidian-blog-publisher/src/model.cjs");
function harness(source = "![[../attachments/a.png]]\n[笔记](./other.md)\n![图](../attachments/a.png)\n\n[ref]: ../attachments/a.png\n`![[../code.png]]`\n```md\n![[../code.png]]\n```") {
	const plugin = new BlogPublisher();
	const files = new Map([
		["notes/source.md", new TFile("notes/source.md", source)],
		["notes/other.md", new TFile("notes/other.md", "other")],
		["attachments/a.png", new TFile("attachments/a.png")],
	]);
	const leaves = [];
	const eventHandlers = {};
	const vault = {
		adapter: { getBasePath: () => "E:/notes" }, configDir: ".obsidian",
		getAbstractFileByPath: (name) => files.get(name),
		read: async (file) => file.text,
		createFolder: async (name) => { if (files.has(name)) throw Error("exists"); files.set(name, { path: name }); },
		create: async (name, text) => { if (files.has(name)) throw Error("exists"); const file = new TFile(name, text); files.set(name, file); return file; },
		createBinary: async (name, bytes) => { if (files.has(name)) throw Error("exists"); const file = new TFile(name); file.bytes = bytes; files.set(name, file); return file; },
		process: async (file, fn) => { file.text = fn(file.text); return file.text; },
		on: (event, handler) => { eventHandlers[`vault:${event}`] = handler; },
	};
	plugin.app = {
		vault,
		workspace: { iterateAllLeaves: (fn) => leaves.forEach(fn), getLeavesOfType: () => [], getActiveFile: () => files.get("notes/source.md"), on: (event, handler) => { eventHandlers[event] = handler; }, onLayoutReady: () => {} },
		metadataCache: { getFileCache: () => ({}), on: () => {}, getFirstLinkpathDest: (name, from) => files.get(name.replace(/^\//, "")) || files.get(path.posix.normalize(path.posix.join(path.posix.dirname(from), name))) },
		fileManager: { getAvailablePathForAttachment: async (name, file) => `${path.posix.dirname(file.path)}/${name}` },
	};
	plugin.state = model.createState();
	const record = model.bindNote(plugin.state, { path: "notes/source.md", basename: "标题" });
	plugin.state.settings.lastRecordId = record.id;
	plugin.store = { save: async () => {}, load: async () => plugin.state };
	plugin.save = async () => {};
	plugin.manifest = { id: "test" };
	plugin.registerView = plugin.registerEvent = plugin.addSettingTab = plugin.addRibbonIcon = plugin.addCommand = () => {};
	return { plugin, record, files, leaves, eventHandlers };
}
for (const status of ["prepared", "committed"]) {
	test(`recovery prioritizes ${status} operation over a recently checked old release`, async () => {
		const { plugin, record } = harness();
		plugin.state.settings.repoPath = "E:/blog";
		const pending = { id: record.id, operationId: "pending", status };
		const published = { id: record.id, operationId: "old-live", status: "live", commit: "abc", contentFingerprint: "old" };
		plugin.getClient = () => ({ request: async () => ({ operations: [pending, published] }) });
		await plugin.recover();
		assert.equal(record.operation.operationId, "pending");
		assert.equal(record.status, status);
		assert.equal(record.lastPublished.commit, "abc");
	});
}
test("creating an optional draft shares attachments, rewrites movable references and retains identity", async () => {
	const { plugin, record, files } = harness();
	const original = files.get(record.sourcePath).text;
	const id = record.id;
	assert.equal(typeof plugin.createDraft, "function");
	await plugin.createDraft(record);
	assert.equal(record.contentMode, "draft");
	assert.equal(record.draftPath, `博客稿/${id}/标题.md`);
	assert.equal(files.get(record.sourcePath).text, original);
	assert.equal(files.get(record.draftPath).text, "![[attachments/a.png]]\n[笔记](/notes/other.md)\n![图](/attachments/a.png)\n\n[ref]: /attachments/a.png\n`![[../code.png]]`\n```md\n![[../code.png]]\n```");
	assert.equal([...files.values()].filter((f) => f instanceof TFile && f.extension === "png").length, 1);
	await plugin.createDraft(record);
	assert.equal(record.id, id);
	assert.equal(model.bindNote(plugin.state, { path: record.draftPath }), record);
});
test("selected draft snapshot reads editor buffers, preserves layouts and resolves shared assets", async () => {
	const { plugin, record, files, leaves } = harness();
	assert.equal(typeof plugin.createDraft, "function");
	await plugin.createDraft(record);
	record.imageLayouts = { "image-1": { width: 50, unit: "%" } };
	const editor = Object.assign(new MarkdownView(), { file: files.get(record.draftPath), editor: { getValue: () => "edited ![](/attachments/a.png)" } });
	leaves.push({ view: editor });
	files.get(record.sourcePath).text = "source independently edited";
	const snapshot = await plugin.snapshot(record);
	assert.equal(snapshot.markdown, "edited ![](/attachments/a.png)");
	assert.equal(snapshot.contentPath, record.draftPath);
	assert.equal(snapshot.resolutions["/attachments/a.png"].notePath, "attachments/a.png");
	assert.deepEqual(snapshot.imageLayouts, record.imageLayouts);
	snapshot.imageLayouts["image-1"].width = 10;
	assert.equal(record.imageLayouts["image-1"].width, 50);
	assert.equal(plugin.imageFile(record, { target: "/attachments/a.png" }), files.get("attachments/a.png"));
});
test("draft writes reject external disk changes and stale queued saves without losing newer text", async () => {
	const { plugin, record, files } = harness("original");
	assert.equal(typeof plugin.createDraft, "function");
	await plugin.createDraft(record);
	assert.equal(await plugin.saveDraft(record, "first", "original"), "first");
	files.get(record.draftPath).text = "external";
	await assert.rejects(plugin.saveDraft(record, "overwrite", "first"), /外部|冲突/);
	assert.equal(files.get(record.draftPath).text, "external");
	const queued = [plugin.saveDraft(record, "saved", "external"), plugin.saveDraft(record, "stale", "external")];
	assert.equal(await queued[0], "saved");
	await assert.rejects(queued[1], /外部|冲突/);
	assert.equal(files.get(record.draftPath).text, "saved");
});
test("missing draft never falls back to source and switching to source retains draft", async () => {
	const { plugin, record, files } = harness("source");
	assert.equal(typeof plugin.createDraft, "function");
	await plugin.createDraft(record);
	const draft = record.draftPath;
	await plugin.setContentMode(record, "source");
	assert.equal(await plugin.readContent(record), "source");
	assert.equal(record.draftPath, draft);
	await plugin.setContentMode(record, "draft");
	files.delete(draft);
	await assert.rejects(plugin.readContent(record), /博客稿/);
	await assert.rejects(plugin.snapshot(record), /博客稿/);
	assert.equal(record.draftMissing, true);
});
test("image insertion follows attachment rules, avoids collisions and rejects oversized or fake images", async () => {
	const { plugin, record, files } = harness();
	assert.equal(typeof plugin.createDraft, "function");
	await plugin.createDraft(record);
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const input = { name: "../bad:name.png", type: "image/png", size: png.length, arrayBuffer: async () => png };
	const first = await plugin.insertDraftImage(record, input);
	const second = await plugin.insertDraftImage(record, input);
	assert.match(decodeURIComponent(first), /^!\[\]\(\/博客稿\//);
	assert.notEqual(first, second);
	assert.equal([...files.values()].filter((f) => f.bytes).length, 2);
	await assert.rejects(plugin.insertDraftImage(record, { ...input, size: 21 * 1024 * 1024 }), /过大|大小/);
	await assert.rejects(plugin.insertDraftImage(record, { ...input, arrayBuffer: async () => Buffer.from("not an image") }), /图片|图像/);
});
test("publication locks prevent content mutations", async () => {
	const { plugin, record } = harness();
	assert.equal(typeof plugin.createDraft, "function");
	plugin.view = () => ({ control: { publishing: true } });
	await assert.rejects(plugin.createDraft(record), /发布/);
	await assert.rejects(plugin.setContentMode(record, "draft"), /发布/);
	await assert.rejects(plugin.saveDraft(record, "x", ""), /发布/);
	await assert.rejects(plugin.insertDraftImage(record, {}), /发布/);
});
test("recovery copies keep unsaved text without replacing either body or prior recovery", async () => {
	const { plugin, record, files } = harness("source");
	assert.equal(typeof plugin.saveDraftRecovery, "function");
	await plugin.createDraft(record);
	const first = await plugin.saveDraftRecovery(record, "unsaved one");
	const second = await plugin.saveDraftRecovery(record, "unsaved two");
	assert.notEqual(first, second);
	assert.equal(files.get(first).text, "unsaved one");
	assert.equal(files.get(second).text, "unsaved two");
	assert.equal(files.get(record.draftPath).text, "source");
});
test("saving from an opened editor accepts its unsaved baseline and still catches later disk changes", async () => {
	const { plugin, record, files, leaves } = harness("disk baseline");
	await plugin.createDraft(record);
	let buffer = "native editor text";
	leaves.push({ view: Object.assign(new MarkdownView(), { file: files.get(record.draftPath), editor: { getValue: () => buffer, setValue: (value) => { buffer = value; } } }) });
	assert.equal(await plugin.readContent(record), "native editor text");
	assert.equal(await plugin.saveDraft(record, "plugin edit", "native editor text"), "plugin edit");
	assert.equal(buffer, "plugin edit");
	assert.equal(files.get(record.draftPath).text, "plugin edit");
	await plugin.readContent(record);
	files.get(record.draftPath).text = "external later";
	await assert.rejects(plugin.saveDraft(record, "overwrite", "plugin edit"), /外部|冲突/);
	assert.equal(files.get(record.draftPath).text, "external later");
});
test("draft creation transfers image settings while retaining the source settings", async () => {
	const { plugin, record } = harness("![a](../attachments/a.png)");
	const { listImages } = require("../../integrations/obsidian-blog-publisher/src/image-layout.cjs");
	const oldKey = listImages(await plugin.readContent(record))[0].key;
	record.imageLayouts = { [oldKey]: { width: 65, unit: "%", align: "left", caption: "caption" } };
	await plugin.createDraft(record);
	const newKey = listImages(await plugin.readContent(record))[0].key;
	assert.notEqual(oldKey, newKey);
	assert.deepEqual(record.imageLayouts[newKey], { width: 65, unit: "%", align: "left", caption: "caption" });
	assert.deepEqual(record.imageLayouts[oldKey], record.imageLayouts[newKey]);
});
test("external opening encodes the selected draft path and falls back when VS Code launch fails", async () => {
	const { plugin, record } = harness();
	await plugin.createDraft(record);
	assert.equal(typeof plugin.openDraftExternal, "function");
	const urls = [];
	const paths = [];
	const load = Module._load;
	Module._load = function (name, ...args) {
		if (name === "electron") return { shell: { openExternal: async (url) => { urls.push(url); throw Error("no VS Code"); }, openPath: async (name) => { paths.push(name); return ""; } } };
		return load.call(this, name, ...args);
	};
	try { await plugin.openDraftExternal(record); } finally { Module._load = load; }
	assert.match(urls[0], /^vscode:\/\/file\//);
	assert.equal(decodeURIComponent(urls[0]).includes("标题.md"), true);
	assert.equal(paths[0], path.join("E:/notes", record.draftPath));
});
test("a native editor change while atomic draft saving is pending aborts before writing", async () => {
	const { plugin, record, files, leaves } = harness("original");
	await plugin.createDraft(record);
	let buffer = "original";
	leaves.push({ view: Object.assign(new MarkdownView(), { file: files.get(record.draftPath), editor: { getValue: () => buffer, setValue: (value) => { buffer = value; } } }) });
	let started;
	const entered = new Promise((resolve) => { started = resolve; });
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	plugin.app.vault.process = async (file, transform) => {
		started();
		await gate;
		file.text = transform(file.text);
		return file.text;
	};
	const rejected = assert.rejects(plugin.saveDraft(record, "plugin text", "original"), /冲突/);
	await entered;
	buffer = "new native text";
	release();
	await rejected;
	assert.equal(files.get(record.draftPath).text, "original");
	assert.equal(buffer, "new native text");
});
test("a newly opened native editor is checked inside the atomic save callback", async () => {
	const { plugin, record, files, leaves } = harness("original");
	await plugin.createDraft(record);
	let started;
	const entered = new Promise((resolve) => { started = resolve; });
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	plugin.app.vault.process = async (file, transform) => {
		started();
		await gate;
		file.text = transform(file.text);
		return file.text;
	};
	const rejected = assert.rejects(plugin.saveDraft(record, "plugin text", "original"), /冲突/);
	await entered;
	leaves.push({ view: Object.assign(new MarkdownView(), { file: files.get(record.draftPath), editor: { getValue: () => "newly opened editor text" } }) });
	release();
	await rejected;
	assert.equal(files.get(record.draftPath).text, "original");
});
test("a native edit after the disk write is preserved and the plugin body gets a recovery copy", async () => {
	const { plugin, record, files, leaves } = harness("original");
	await plugin.createDraft(record);
	let buffer = "original";
	leaves.push({ view: Object.assign(new MarkdownView(), { file: files.get(record.draftPath), editor: { getValue: () => buffer, setValue: (value) => { buffer = value; } } }) });
	let started;
	const entered = new Promise((resolve) => { started = resolve; });
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	plugin.app.vault.process = async (file, transform) => {
		file.text = transform(file.text);
		started();
		await gate;
		return file.text;
	};
	let conflict;
	const rejected = assert.rejects(plugin.saveDraft(record, "plugin text", "original"), (error) => { conflict = error; return /冲突/.test(error.message); });
	await entered;
	buffer = "new native text";
	release();
	await rejected;
	assert.equal(buffer, "new native text");
	assert.equal(files.get(record.draftPath).text, "plugin text");
	assert.equal(files.get(conflict.recoveryPath)?.text, "plugin text");
});
