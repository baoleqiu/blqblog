const { test } = require("node:test");
const assert = require("node:assert/strict");
let Controller;
try {
	({
		PreviewController: Controller,
	} = require("../../integrations/obsidian-blog-publisher/src/controller.cjs"));
} catch (e) {
	if (e.code !== "MODULE_NOT_FOUND") throw e;
}
test("preview stays pinned and stale results or unloaded frames cannot enable publication", () => {
	assert.equal(typeof Controller, "function");
	const c = new Controller();
	c.bind("one");
	const old = c.begin();
	c.invalidate();
	const latest = c.begin();
	assert.equal(c.accept(old, { fingerprint: "old", issues: [] }), false);
	assert.equal(c.ready(), false);
	assert.equal(c.accept(latest, { fingerprint: "new", issues: [] }), true);
	assert.equal(c.ready(), false);
	c.displayed("old");
	assert.equal(c.ready(), false);
	c.displayed("new");
	assert.equal(c.ready(), true);
	assert.equal(c.id, "one");
	c.invalidate();
	assert.equal(c.ready(), false);
});
test("missing sources, blocking issues and active publication disable publish", () => {
	assert.equal(typeof Controller, "function");
	const c = new Controller();
	c.bind("one");
	let generation = c.begin();
	c.accept(generation, { fingerprint: "v", issues: [{ severity: "error" }] });
	c.displayed("v");
	assert.equal(c.ready(), false);
	c.accept(generation, { fingerprint: "v", issues: [] });
	c.displayed("v");
	c.publishing = true;
	assert.equal(c.ready(), false);
	c.publishing = false;
	c.missing = true;
	assert.equal(c.ready(), false);
});
