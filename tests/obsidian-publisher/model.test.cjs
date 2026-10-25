const { test } = require("node:test");
const assert = require("node:assert/strict");
let model = {};
try {
	model = require("../../integrations/obsidian-blog-publisher/src/model.cjs");
} catch (error) {
	if (error.code !== "MODULE_NOT_FOUND") throw error;
}
function fresh() {
	assert.equal(
		typeof model.createState,
		"function",
		"article model is not implemented",
	);
	return model.createState({
		vaultRoot: "E:/notes",
		repoPath: "E:/blog",
		siteUrl: "https://example.test",
	});
}
test("startup detects an offline move without reassigning or deleting the published article", () => {
	const state = fresh();
	const record = model.bindNote(state, {
		path: "old/note.md",
		basename: "Note",
	});
	record.status = "live";
	record.lastPublished = { commit: "abc" };
	const id = record.id;
	assert.equal(typeof model.reconcileSources, "function");
	model.reconcileSources(state, (path) => path === "new/note.md");
	assert.equal(record.sourceMissing, true);
	assert.equal(record.id, id);
	assert.equal(record.status, "live");
	assert.equal(record.sourcePath, "old/note.md");
	model.relinkSource(state, id, "new/note.md");
	assert.equal(record.sourceMissing, false);
	assert.equal(record.id, id);
});

test("reopening and renaming a note keeps its article identity and public URL", () => {
	const state = fresh();
	const first = model.bindNote(state, {
		path: "实验/CD8.md",
		basename: "CD8",
		frontmatter: { tags: ["免疫学"] },
	});
	assert.equal(model.bindNote(state, { path: "实验/CD8.md" }).id, first.id);
	const url = first.blogPath;
	model.updateMetadata(first, { title: "新的标题" });
	model.renameSource(state, "实验/CD8.md", "protocol/新名称.md");
	assert.equal(first.blogPath, url);
	assert.equal(
		model.bindNote(state, { path: "protocol/新名称.md" }).id,
		first.id,
	);
});
test("frontmatter seeds metadata once without later overwriting panel edits", () => {
	const state = fresh();
	const fm = Object.freeze({
		category: "实验记录",
		tags: Object.freeze(["CD8"]),
		title: "原题",
	});
	const record = model.bindNote(state, {
		path: "a.md",
		basename: "a",
		frontmatter: fm,
	});
	model.updateMetadata(record, {
		title: "面板标题",
		tags: ["标签", "标签", "免疫学"],
	});
	model.bindNote(state, {
		path: "a.md",
		frontmatter: { title: "后来改的源属性" },
	});
	assert.equal(record.metadata.title, "面板标题");
	assert.deepEqual(record.metadata.tags, ["标签", "免疫学"]);
	assert.equal(fm.title, "原题");
});
test("source deletion marks a missing source while keeping the published record", () => {
	const state = fresh();
	const record = model.bindNote(state, { path: "a.md", basename: "a" });
	record.lastPublished = { revision: "r1", contentFingerprint: "h1" };
	model.markSourceMissing(state, "a.md");
	assert.equal(state.records.length, 1);
	assert.equal(record.sourceMissing, true);
	assert.equal(record.lastPublished.revision, "r1");
});
test("metadata validation rejects future/invalid dates and normalizes optional fields", () => {
	fresh();
	assert.throws(
		() =>
			model.normalizeMetadata(
				{ title: "x", published: "2026-02-30" },
				"2026-10-25",
			),
		/日期/,
	);
	assert.throws(
		() =>
			model.normalizeMetadata(
				{ title: "x", published: "2027-01-01" },
				"2026-10-25",
			),
		/未来/,
	);
	assert.throws(
		() => model.normalizeMetadata({ title: "  " }, "2026-10-25"),
		/标题/,
	);
	const metadata = model.normalizeMetadata(
		{ title: " x ", tags: ["#one", "one", "two"], category: "  " },
		"2026-10-25",
	);
	assert.equal(metadata.title, "x");
	assert.deepEqual(metadata.tags, ["one", "two"]);
	assert.equal(metadata.category, "");
});
test("backup import rejects foreign vaults and conflicting article records atomically", () => {
	const state = fresh();
	model.bindNote(state, { path: "a.md", basename: "a" });
	const unchanged = JSON.stringify(state);
	const foreign = structuredClone(state);
	foreign.settings.vaultRoot = "E:/other";
	assert.throws(() => model.validateImport(state, foreign), /笔记库/);
	const conflicting = structuredClone(state);
	conflicting.records[0].sourcePath = "different.md";
	assert.throws(() => model.validateImport(state, conflicting), /冲突/);
	assert.equal(JSON.stringify(state), unchanged);
});
test("explicit relinking cannot claim a source already bound to another article", () => {
	const state = fresh();
	const a = model.bindNote(state, { path: "a.md", basename: "a" });
	model.bindNote(state, { path: "b.md", basename: "b" });
	assert.throws(() => model.relinkSource(state, a.id, "b.md"), /关联/);
	assert.equal(a.sourcePath, "a.md");
});
