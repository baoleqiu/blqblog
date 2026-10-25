import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { fixtureImage, temporary } from "./fixtures.mjs";

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

test("small images are served unchanged without an extra display file", async (t) => {
	const dir = await temporary(t);
	const sourcePath = await fixtureImage(dir);
	const result = await prepare({
		sourcePath,
		vaultRoot: dir,
		id: "test-article-1234",
	});
	assert.equal(result.displayUrl, result.originalUrl);
	assert.equal(Object.keys(result.files).length, 1);
});

test("large images use a smaller display copy while retaining the original", async (t) => {
	const dir = await temporary(t);
	const sourcePath = path.join(dir, "large.png");
	await sharp({
		create: { width: 3000, height: 2000, channels: 3, background: "red" },
	})
		.png()
		.toFile(sourcePath);
	const result = await prepare({
		sourcePath,
		vaultRoot: dir,
		id: "test-article-1234",
	});
	assert.notEqual(result.displayUrl, result.originalUrl);
	assert.ok(
		result.files[`public${result.displayUrl}`].length <
			result.files[`public${result.originalUrl}`].length,
	);
	assert.equal(result.width, 1920);
	assert.equal(result.height, 1280);
	assert.deepEqual(
		result.files[`public${result.originalUrl}`],
		await fs.readFile(sourcePath),
	);
});

test("an efficient large original is retained when conversion would increase download size", async (t) => {
	const dir = await temporary(t);
	const sourcePath = path.join(dir, "efficient.avif");
	await sharp({
		create: { width: 2400, height: 1600, channels: 3, background: "red" },
	})
		.avif({ quality: 30 })
		.toFile(sourcePath);
	const result = await prepare({
		sourcePath,
		vaultRoot: dir,
		id: "test-article-1234",
	});
	assert.equal(result.displayUrl, result.originalUrl);
	assert.equal(Object.keys(result.files).length, 1);
	assert.equal(result.width, 2400);
	assert.equal(result.height, 1600);
});

test("original fallback reports the displayed dimensions of an EXIF-rotated photo", async (t) => {
	const dir = await temporary(t);
	const sourcePath = path.join(dir, "rotated.jpg");
	await sharp({
		create: { width: 80, height: 40, channels: 3, background: "red" },
	})
		.withMetadata({ orientation: 6 })
		.jpeg()
		.toFile(sourcePath);
	const result = await prepare({
		sourcePath,
		vaultRoot: dir,
		id: "test-article-1234",
	});
	assert.equal(result.displayUrl, result.originalUrl);
	assert.equal(result.width, 40);
	assert.equal(result.height, 80);
	assert.deepEqual(
		result.files[`public${result.displayUrl}`],
		await fs.readFile(sourcePath),
	);
});
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
