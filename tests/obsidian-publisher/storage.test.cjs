const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
let storage = {};
try { storage = require("../../integrations/obsidian-blog-publisher/src/storage.cjs"); }
catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
async function setup(t) {
	assert.equal(typeof storage.DataStore, "function", "plugin data storage is not implemented");
	const root = path.resolve("cache/obsidian-publisher-tests");
	await fs.mkdir(root, { recursive: true });
	const dir = await fs.mkdtemp(path.join(root, "store-"));
	t.after(async () => { if (!dir.startsWith(root + path.sep)) throw Error("invalid cleanup"); await fs.rm(dir, { recursive: true, force: true }); });
	const resolve = (p) => path.join(dir, p);
	const adapter = {
		exists: async (p) => fs.stat(resolve(p)).then(() => true, () => false),
		read: (p) => fs.readFile(resolve(p), "utf8"), write: (p, s) => fs.writeFile(resolve(p), s),
		mkdir: (p) => fs.mkdir(resolve(p), { recursive: true }),
		rename: (a,b) => fs.rename(resolve(a), resolve(b)), remove: (p) => fs.rm(resolve(p), { force: true }),
	};
	return { store: new storage.DataStore(adapter, "plugin"), dir };
}
function state(title) { return { version: 1, settings: { vaultRoot: "E:/notes", repoPath: "E:/blog" }, records: [{ id: "12345678-1234-4234-8234-123456789012", sourcePath: "a.md", blogPath: "/posts/obsidian/12345678-1234-4234-8234-123456789012/", metadata: { title, category: "", tags: [], description: "", cover: "", published: "" } }] }; }
test("saved state survives a new store and does not create a markdown file", async (t) => {
	const { store, dir } = await setup(t);
	await store.save(state("标题"));
	assert.equal((await store.load()).records[0].metadata.title, "标题");
	assert.deepEqual((await fs.readdir(path.join(dir, "plugin"))).filter(x=>x.endsWith(".md")), []);
});
test("a damaged primary file recovers the last valid backup and reports recovery", async (t) => {
	const { store, dir } = await setup(t);
	await store.save(state("first")); await store.save(state("second"));
	await fs.writeFile(path.join(dir, "plugin/data.json"), "{broken");
	const restored = await store.load();
	assert.equal(restored.records[0].metadata.title, "first");
	assert.equal(store.recovered, true);
});
test("queued saves capture each value and retain the newest valid state", async (t) => {
	const { store } = await setup(t); const changing = state("one");
	const first = store.save(changing); changing.records[0].metadata.title = "two";
	const second = store.save(changing); await Promise.all([first, second]);
	assert.equal((await store.load()).records[0].metadata.title, "two");
	assert.equal(JSON.parse(await store.export()).records[0].metadata.title, "two");
});
test("invalid imported data leaves the current state intact", async (t) => {
	const { store } = await setup(t); await store.save(state("kept"));
	await assert.rejects(() => store.import('{"version":999}'), /版本|格式/);
	assert.equal((await store.load()).records[0].metadata.title, "kept");
});
