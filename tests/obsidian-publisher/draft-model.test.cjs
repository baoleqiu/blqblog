const { test } = require("node:test");
const assert = require("node:assert/strict");
const model = require("../../integrations/obsidian-blog-publisher/src/model.cjs");
function fixture() {
	const state = model.createState();
	const record = model.bindNote(state, { path: "notes/source.md" });
	record.draftPath = `博客稿/${record.id}/标题.md`;
	record.contentMode = "draft";
	return { state, record };
}
test("reopening an article with an existing draft defaults to that draft", () => {
	const { state, record } = fixture();
	record.contentMode = "source";
	model.bindNote(state, { path: record.sourcePath });
	assert.equal(record.contentMode, "draft");
});
test("binding an existing blog draft preserves its article identity and original source", () => {
	const { state, record } = fixture();
	assert.equal(model.bindNote(state, { path: record.draftPath }), record);
	assert.equal(state.records.length, 1);
	assert.equal(record.sourcePath, "notes/source.md");
});
test("source and draft rename or deletion are tracked independently", () => {
	const { state, record } = fixture();
	model.renameSource(state, "博客稿", "写作");
	assert.equal(record.draftPath, `写作/${record.id}/标题.md`);
	model.markSourceMissing(state, "notes");
	assert.equal(record.sourceMissing, true);
	assert.equal(Boolean(record.draftMissing), false);
	model.reconcileSources(state, (name) => name === "notes/source.md");
	assert.equal(record.sourceMissing, false);
	assert.equal(record.draftMissing, true);
});
test("legacy state stays valid and draft/layout fields survive backup validation", () => {
	const { state, record } = fixture();
	record.imageLayouts = {
		"image-1": { width: 60, unit: "%", align: "center", caption: "图" },
	};
	assert.deepEqual(model.validateState(state).records[0], record);
	delete record.draftPath;
	delete record.contentMode;
	delete record.imageLayouts;
	assert.deepEqual(model.validateState(state), state);
});
test("invalid modes, unsafe draft paths and duplicated source/draft bindings are rejected", () => {
	const { state, record } = fixture();
	for (const patch of [
		{ contentMode: "unknown" },
		{ draftPath: "../outside.md" },
		{ draftPath: "C:/outside.md" },
		{ contentMode: "draft", draftPath: undefined },
	]) {
		assert.throws(
			() =>
				model.validateState({ ...state, records: [{ ...record, ...patch }] }),
			/稿|正文|格式/,
		);
	}
	const other = model.bindNote(state, { path: "other.md" });
	other.draftPath = record.sourcePath;
	assert.throws(() => model.validateState(state), /重复|冲突/);
	assert.throws(
		() => model.relinkSource(state, other.id, record.draftPath),
		/关联/,
	);
});
test("backup validation rejects invalid image widths without changing valid stored settings", () => {
	const { state, record } = fixture();
	record.imageLayouts = { a: { width: 101, unit: "%" } };
	assert.throws(() => model.validateState(state), /图片|宽度/);
	record.imageLayouts = { a: null };
	assert.deepEqual(model.validateState(state).records[0].imageLayouts, {
		a: null,
	});
});
