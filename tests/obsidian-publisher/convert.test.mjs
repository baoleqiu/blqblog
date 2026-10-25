import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { parseFrontmatter } from "@astrojs/markdown-remark";
import { fixtureImage, note, temporary } from "./fixtures.mjs";

let converter = {};
try {
	converter = await import("../../scripts/obsidian-publisher/convert.mjs");
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
async function convert(snapshot) {
	assert.equal(
		typeof converter.convertNote,
		"function",
		"converter is not implemented",
	);
	return converter.convertNote(snapshot);
}

test("plain prose, tables, nested lists, unicode and callouts retain original body characters", async () => {
	const body =
		"# 标题\n\n| 项目 | 数值 |\n|---|---|\n|甲|10⁸|\n\n- **事项**\n  - 子项\n\n> [!note]- 提示\n> 一段话\n";
	const result = await convert(note(body));
	assert.ok(result.markdown.endsWith(body));
	assert.equal(result.issues.filter((i) => i.severity === "error").length, 0);
	assert.ok(
		parseFrontmatter(result.markdown).frontmatter.published instanceof Date,
		"Astro schema requires a YAML date",
	);
});
test("code blocks, inline code and escaped wikilinks are not interpreted as embeds", async () => {
	const body =
		"```md\n![[秘密照片.jpg]]\n==code==\n```\n`[[code]]` 与 \\[[escaped]]\n==真正高亮==";
	const result = await convert(note(body));
	assert.ok(result.markdown.includes("![[秘密照片.jpg]]"));
	assert.ok(result.markdown.includes("`[[code]]` 与 \\[[escaped]]"));
	assert.ok(result.markdown.includes("<mark>真正高亮</mark>"));
	assert.equal(result.issues.length, 0);
});
test("wikilinks use explicit published mappings, keep aliases and warn on unpublished notes", async () => {
	const result = await convert(
		note("[[已发表#段落|显示名]]，[[私人笔记|自己的记录]]", {
			resolutions: {
				已发表: {
					path: "E:/notes/已发表.md",
					notePath: "已发表.md",
					kind: "note",
				},
				私人笔记: {
					path: "E:/notes/私人.md",
					notePath: "私人.md",
					kind: "note",
				},
			},
			publishedLinks: { "已发表.md": "/posts/existing/" },
		}),
	);
	assert.ok(result.markdown.includes("[显示名](/posts/existing/)"));
	assert.ok(result.markdown.includes("自己的记录"));
	assert.ok(!result.markdown.includes("[["));
	assert.ok(result.issues.some((i) => i.code === "unpublished-link"));
	assert.ok(result.issues.some((i) => i.code === "anchor-fallback"));
});
test("note embeds and dynamic queries block publishing rather than silently dropping content", async () => {
	const result = await convert(
		note("![[实验日记]]\n\n```dataview\nLIST\n```\n\n```tasks\nnot done\n```"),
	);
	assert.ok(
		result.issues.some(
			(i) => i.code === "note-embed" && i.severity === "error",
		),
	);
	assert.ok(
		result.issues.some(
			(i) => i.code === "dynamic-query" && i.severity === "error",
		),
	);
});
test("valid math is preserved and unsupported math commands are reported", async () => {
	const good = await convert(note("$x^2$\n\n$$\n\\frac{1}{2}\n$$"));
	assert.equal(good.issues.filter((i) => i.severity === "error").length, 0);
	const bad = await convert(note("$\\unknownPublisherCommand{x}$"));
	assert.ok(
		bad.issues.some((i) => i.code === "math" && i.severity === "error"),
	);
});
test("source private properties do not leak into generated public frontmatter", async () => {
	const result = await convert(
		note("---\nprivateField: do-not-publish\ntitle: source-title\n---\n正文", {
			metadata: {
				title: "标题\n---\ninjected: yes",
				tags: ["免疫学"],
				published: "2026-01-01",
			},
		}),
	);
	assert.ok(!result.markdown.includes("do-not-publish"));
	assert.ok(result.markdown.includes('title: "标题\\n---\\ninjected: yes"'));
	assert.ok(result.markdown.endsWith("正文"));
});
test("wiki and markdown image references export bytes, widths and usable original links", async (t) => {
	const dir = await temporary(t);
	const image = await fixtureImage(dir);
	const before = await fs.readFile(image);
	const snapshot = note("![[照片 空格.png|40]]\n\n![图](照片%20空格.png)", {
		vaultRoot: dir,
		resolutions: { "照片 空格.png": { path: image, kind: "image" } },
	});
	const result = await convert(snapshot);
	assert.equal(result.assets.length, 1);
	assert.ok(result.markdown.includes('width="40"'));
	assert.ok(result.markdown.includes("查看原图"));
	assert.ok(result.markdown.includes("/originals/"));
	assert.deepEqual(await fs.readFile(image), before);
	assert.equal(result.issues.filter((i) => i.severity === "error").length, 0);
});
test("missing images, invalid ids and malformed metadata cannot produce a publishable candidate", async () => {
	const missing = await convert(note("![[missing.png]]"));
	assert.ok(
		missing.issues.some(
			(i) => i.code === "missing-asset" && i.severity === "error",
		),
	);
	await assert.rejects(
		() => convert(note("x", { id: "../../escape" })),
		/标识/,
	);
	const invalid = await convert(
		note("x", { metadata: { title: "", published: "2026-99-99" } }),
	);
	assert.ok(
		invalid.issues.some((i) => i.code === "metadata" && i.severity === "error"),
	);
});
test("highlight does not rewrite destinations or reference definitions and preserves nested emphasis", async () => {
	const body =
		"[下载](https://example.test/==file==)\n\n[资料][x]\n\n[x]: https://example.test/==file==\n\n==**加粗**==";
	const result = await convert(note(body));
	assert.ok(result.markdown.includes("[下载](https://example.test/==file==)"));
	assert.ok(result.markdown.includes("[x]: https://example.test/==file=="));
	assert.ok(result.markdown.includes("<mark><strong>加粗</strong></mark>"));
});
test("real content updates emit a stable update date without changing original publication or idempotence", async () => {
	const first = await convert(note("first"));
	const prior = { contentFingerprint: first.contentFingerprint };
	const updated = await convert(note("second", { lastPublished: prior }));
	const fields = parseFrontmatter(updated.markdown).frontmatter;
	assert.ok(fields.updated instanceof Date);
	assert.equal(fields.published.toISOString().slice(0, 10), "2026-01-01");
	const repeat = await convert(
		note("second", {
			lastPublished: {
				contentFingerprint: updated.contentFingerprint,
				updated: updated.updated,
			},
		}),
	);
	assert.equal(repeat.contentFingerprint, updated.contentFingerprint);
	assert.equal(repeat.markdown, updated.markdown);
});
