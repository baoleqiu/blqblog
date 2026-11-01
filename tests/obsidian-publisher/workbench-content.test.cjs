const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	DraftBuffer,
	ArticleContent,
} = require("../../integrations/obsidian-blog-publisher/src/workbench-content.cjs");
test("image import captures insertion position and flush waits for imported references", async () => {
	let finish;
	const editor = {
		value: "AB",
		selectionStart: 1,
		selectionEnd: 1,
		focus() {},
	};
	const content = Object.create(ArticleContent.prototype);
	Object.assign(content, {
		input: editor,
		record: { contentMode: "draft" },
		text: "AB",
		ready: Promise.resolve(),
		plugin: {
			insertDraftImage: () =>
				new Promise((r) => {
					finish = r;
				}),
		},
		view: { control: {}, changed() {}, buttons() {} },
		buffer: {
			base: "AB",
			queue: Promise.resolve(),
			save: async (text) => {
				content.buffer.base = text;
			},
		},
	});
	const importing = content.insertImages([{}]);
	await Promise.resolve();
	editor.selectionStart = 2;
	editor.selectionEnd = 2;
	let flushed = false;
	const flush = content.flush().then(() => {
		flushed = true;
	});
	await Promise.resolve();
	assert.equal(flushed, false);
	finish("![](image.png)");
	await importing;
	await flush;
	assert.equal(editor.value, "A\n![](image.png)\nB");
	assert.equal(content.buffer.base, editor.value);
});
test("draft buffer serializes captured edits against the last successful disk version", async () => {
	let disk = "original";
	const writes = [];
	const plugin = {
		saveDraft: async (_r, text, expected) => {
			assert.equal(expected, disk);
			writes.push(text);
			disk = text;
			return text;
		},
	};
	const buffer = new DraftBuffer(plugin, {}, disk);
	await Promise.all([buffer.save("first"), buffer.save("second")]);
	assert.deepEqual(writes, ["first", "second"]);
	assert.equal(buffer.base, "second");
});
test("draft buffer keeps conflict and never retries overwriting an external change", async () => {
	let calls = 0;
	const buffer = new DraftBuffer(
		{
			saveDraft: async () => {
				calls++;
				throw Error("external change");
			},
		},
		{},
		"old",
	);
	await assert.rejects(buffer.save("mine"), /external/);
	await assert.rejects(buffer.save("newer"), /external/);
	assert.equal(calls, 1);
	assert.equal(buffer.base, "old");
});
