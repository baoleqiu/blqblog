import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import * as preview from "../../scripts/obsidian-publisher/preview.mjs";
import { temporary } from "./fixtures.mjs";

test("closing preview removes only its own workspace and preserves operation journals", async (t) => {
	const repo = await temporary(t);
	const manager = new preview.PreviewManager(repo);
	await fs.mkdir(manager.root, { recursive: true });
	await fs.writeFile(path.join(manager.root, "temporary.txt"), "cache");
	const operations = path.join(repo, "cache/obsidian-publisher/operations");
	await fs.mkdir(operations);
	await fs.writeFile(path.join(operations, "keep.json"), "journal");
	await manager.stop();
	await assert.rejects(fs.access(manager.root));
	assert.equal(
		await fs.readFile(path.join(operations, "keep.json"), "utf8"),
		"journal",
	);
});

test("HTTP 200 with an older article cannot certify the new preview", async () => {
	assert.equal(typeof preview.waitForCandidate, "function");
	let count = 0;
	await preview.waitForCandidate("http://127.0.0.1/article", "new", {
		attempts: 3,
		interval: 0,
		fetchImpl: async () => ({
			ok: true,
			text: async () =>
				`<span hidden data-blq-preview="${++count === 3 ? "new" : "old"}"></span>`,
		}),
	});
	assert.equal(count, 3);
	await assert.rejects(
		preview.waitForCandidate("http://127.0.0.1/article", "new", {
			attempts: 2,
			interval: 0,
			fetchImpl: async () => ({
				ok: true,
				text: async () => '<span data-blq-preview="old"></span>',
			}),
		}),
		/预览/,
	);
});
