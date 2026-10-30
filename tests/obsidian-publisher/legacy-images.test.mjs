import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { migrateArticle } from "../../scripts/migrate-legacy-images.mjs";
import { fixtureImage, temporary } from "./fixtures.mjs";

test("legacy migration preserves metadata, prose, captions and original bytes and is idempotent", async (t) => {
	const root = await temporary(t);
	const image = await fixtureImage(root);
	const source =
		"---\ntitle: Old post\npublished: 2026-01-01\n---\n正文\n\n![说明](照片%20空格.png)\n\n`![code](missing.png)`\n\n后续正文";
	const result = await migrateArticle(source, path.join(root, "post.md"), root);
	assert.equal(result.images, 1);
	assert.ok(result.text.startsWith(source.split("正文")[0]));
	assert.ok(result.text.endsWith("`![code](missing.png)`\n\n后续正文"));
	assert.match(result.text, /data-no-swup data-fancybox="blq-images"/);
	assert.match(result.text, /<figcaption>说明<\/figcaption>/);
	const original = Object.keys(result.files).find((name) =>
		name.includes("/originals/"),
	);
	assert.deepEqual(result.files[original], await fs.readFile(image));
	assert.equal(
		(await migrateArticle(result.text, path.join(root, "post.md"), root)).text,
		result.text,
	);
	const draft = source.replace(
		"title: Old post",
		"draft: true\ntitle: Old post",
	);
	assert.equal(
		(await migrateArticle(draft, path.join(root, "post.md"), root)).images,
		0,
	);
});
