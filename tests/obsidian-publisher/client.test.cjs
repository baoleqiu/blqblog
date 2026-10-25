const { test } = require("node:test");
const assert = require("node:assert/strict");
const _path = require("node:path");
let Client;
try {
	({
		PublisherClient: Client,
	} = require("../../integrations/obsidian-blog-publisher/src/client.cjs"));
} catch (e) {
	if (e.code !== "MODULE_NOT_FOUND") throw e;
}
test("client correlates worker errors, stops cleanly and fails pending requests on exit", async (t) => {
	assert.equal(typeof Client, "function");
	const client = new Client({
		nodePath: process.execPath,
		repoPath: process.cwd(),
	});
	t.after(() => client.dispose());
	await assert.rejects(client.request("unsupported", {}), /命令/);
	const pending = client.request("preview", {});
	client.child.kill();
	await assert.rejects(pending, /退出|关闭/);
});
