import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { temporary, fixtureImage } from "./fixtures.mjs";
let assets = {};
try {
	assets = await import("../../scripts/obsidian-publisher/assets.mjs");
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
async function prepare(args) {
	assert.equal(
		typeof assets.prepareImage,
		"function",
		"image exporter is not implemented",
	);
	return assets.prepareImage(args);
}
test("original bytes are preserved while small transparent images are not enlarged", async (t) => {
	const dir = await temporary(t);
	const sourcePath = await fixtureImage(dir);
	const result = await prepare({
		sourcePath,
		vaultRoot: dir,
		id: "test-article-1234",
	});
	assert.deepEqual(
		result.files[`public${result.originalUrl}`],
		await fs.readFile(sourcePath),
	);
	const display = await sharp(
		result.files[`public${result.displayUrl}`],
	).metadata();
	assert.equal(display.width, 80);
	assert.equal(display.height, 40);
	assert.equal(display.hasAlpha, true);
});
test("same filename with different contents receives different URLs and fingerprints", async (t) => {
	const dir = await temporary(t);
	const a = await fixtureImage(dir, "a/photo.png");
	const b = await fixtureImage(dir, "b/photo.png", {
		r: 0,
		g: 255,
		b: 0,
		alpha: 1,
	});
	const first = await prepare({
		sourcePath: a,
		vaultRoot: dir,
		id: "test-article-1234",
	});
	const second = await prepare({
		sourcePath: b,
		vaultRoot: dir,
		id: "test-article-1234",
	});
	assert.notEqual(first.hash, second.hash);
	assert.notEqual(first.originalUrl, second.originalUrl);
});
test("an attachment outside the selected vault is rejected", async (t) => {
	const dir = await temporary(t);
	const sourcePath = await fixtureImage(dir);
	const sub = path.join(dir, "vault");
	await fs.mkdir(sub);
	await assert.rejects(
		() => prepare({ sourcePath, vaultRoot: sub, id: "test-article-1234" }),
		/目录|越界/,
	);
});
