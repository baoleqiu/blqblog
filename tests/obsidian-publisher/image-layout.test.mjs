import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import sanitizeHtml from "sanitize-html";
import { convertNote } from "../../scripts/obsidian-publisher/convert.mjs";
import { fixtureImage, note, temporary } from "./fixtures.mjs";

let imageLayout = {};
try {
	imageLayout = (
		await import(
			"../../integrations/obsidian-blog-publisher/src/image-layout.cjs"
		)
	).default;
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
function listImages(markdown) {
	assert.equal(
		typeof imageLayout.listImages,
		"function",
		"shared image inventory is not implemented",
	);
	return imageLayout.listImages(markdown);
}

test("image inventory identifies each occurrence and stays stable across prose and different-image insertion", () => {
	const source =
		"---\ncover: '![[private.png]]'\n---\n正文 ![[same.png|120]]\n\n![标签](same.png)\n\n![标签](same.png)\n\n![参考][pic]\n\n[pic]: <folder/a b.png> \"title\"\n\n![远程](https://example.test/image.png)";
	const images = listImages(source);
	assert.deepEqual(
		images.map(({ target, alt, size, line }) => ({ target, alt, size, line })),
		[
			{ target: "same.png", alt: "", size: "120", line: 4 },
			{ target: "same.png", alt: "标签", size: "", line: 6 },
			{ target: "same.png", alt: "标签", size: "", line: 8 },
			{ target: "folder/a b.png", alt: "参考", size: "", line: 10 },
			{
				target: "https://example.test/image.png",
				alt: "远程",
				size: "",
				line: 14,
			},
		],
	);
	assert.equal(new Set(images.map((image) => image.key)).size, 5);
	for (const image of images)
		assert.ok(source.slice(image.start, image.end).startsWith("!"));
	const changed = listImages(
		source.replace("正文 ", "另一段文字。\n![[other.png]]\n正文 "),
	);
	assert.deepEqual(
		changed
			.filter((image) => image.target !== "other.png")
			.map((image) => image.key),
		images.map((image) => image.key),
	);
});

test("image inventory follows Markdown syntax and excludes protected code, math, html, and escaped embeds", () => {
	const source = [
		"`![inline](bad.png)` ``![[inline.png]]``",
		"~~~md",
		"![fenced](bad.png)",
		"![[fenced.png]]",
		"~~~",
		"    ![[indented.png]]",
		"\\![[escaped.png]] \\![escaped](bad.png)",
		"<!-- ![[comment.png]] -->",
		"<pre>![[html.png]]</pre>",
		"$![[math.png]]$",
		"$$",
		"![[math-block.png]]",
		"$$",
		'![nested [label]](folder/a\\(1\\).png "title")',
		"[![linked](linked.png)](https://example.test/)",
		"![reference][]",
		"![shortcut]",
		"",
		"[reference]: ref.png",
		"[shortcut]: shortcut.png",
		"![[folder/valid.png|图注]]",
	].join("\n");
	assert.deepEqual(
		listImages(source).map(({ target, alt }) => ({ target, alt })),
		[
			{ target: "folder/a(1).png", alt: "nested [label]" },
			{ target: "linked.png", alt: "linked" },
			{ target: "ref.png", alt: "reference" },
			{ target: "shortcut.png", alt: "shortcut" },
			{ target: "folder/valid.png", alt: "图注" },
		],
	);
});

test("layout normalization preserves old records and rejects unsafe or out-of-range settings", () => {
	assert.equal(
		typeof imageLayout.normalizeLayout,
		"function",
		"layout validation is not implemented",
	);
	assert.equal(imageLayout.normalizeLayout(undefined), null);
	assert.equal(imageLayout.normalizeLayout(null), null);
	assert.deepEqual(
		imageLayout.normalizeLayout({
			width: "42.5",
			unit: "%",
			align: "right",
			caption: "说明",
		}),
		{ width: 42.5, unit: "%", align: "right", caption: "说明" },
	);
	assert.deepEqual(imageLayout.normalizeLayout({ width: 320, unit: "px" }), {
		width: 320,
		unit: "px",
		align: "center",
		caption: "",
	});
	for (const invalid of [
		{},
		{ width: 0 },
		{ width: -1 },
		{ width: 101, unit: "%" },
		{ width: 10001, unit: "px" },
		{ width: "50;display:none" },
		{ width: Number.POSITIVE_INFINITY },
		{ width: 20, unit: "em" },
		{ width: 20, align: "bad" },
		{ width: 20, caption: {} },
	]) {
		assert.throws(
			() => imageLayout.normalizeLayout(invalid),
			/图片|宽度|单位|对齐|图注/,
		);
	}
});

test("explicit layouts give repeated local images separate widths, captions, native dimensions, and fingerprints", async (t) => {
	const dir = await temporary(t);
	const image = await fixtureImage(dir);
	const original = await fs.readFile(image);
	const markdown =
		"---\nprivate: true\n---\n![[照片 空格.png|40]]\n\n![图](照片%20空格.png)\n\n![图](照片%20空格.png)";
	const images = listImages(markdown);
	const source = note(markdown, {
		vaultRoot: dir,
		resolutions: { "照片 空格.png": { path: image, kind: "image" } },
	});
	const before = await convertNote(source);
	const layouts = {
		[images[0].key]: {
			width: 50,
			unit: "%",
			align: "left",
			caption: '<script>alert("x")</script> & 说明',
		},
		[images[1].key]: {
			width: 320,
			unit: "px",
			align: "right",
			caption: "另一处",
		},
	};
	const result = await convertNote({ ...source, imageLayouts: layouts });
	assert.equal(result.issues.length, 0);
	assert.equal((result.markdown.match(/blq-image-layout/g) || []).length, 2);
	assert.match(result.markdown, /data-align="left" style="width:50%"/);
	assert.match(result.markdown, /data-align="right" style="width:320px"/);
	assert.match(
		result.markdown,
		/<span class="blq-image-caption">&lt;script&gt;alert&#40;&quot;x&quot;&#41;&lt;\/script&gt; &amp; 说明<\/span>/,
	);
	assert.equal(
		(result.markdown.match(/width="80" height="40"/g) || []).length,
		3,
	);
	assert.equal(
		(result.markdown.match(/data-fancybox="blq-images"/g) || []).length,
		3,
	);
	assert.notEqual(result.contentFingerprint, before.contentFingerprint);
	assert.equal(
		(await convertNote({ ...source, imageLayouts: layouts })).fingerprint,
		result.fingerprint,
	);
	assert.deepEqual(await fs.readFile(image), original);
});

test("remote layouts are escaped and invalid selected layouts block publication", async () => {
	const markdown = "![remote](https://example.test/a.png?x=1&y=2)";
	const [image] = listImages(markdown);
	const before = await convertNote(note(markdown));
	assert.ok(before.markdown.endsWith(markdown));
	const result = await convertNote(
		note(markdown, {
			imageLayouts: {
				[image.key]: {
					width: 75,
					unit: "%",
					align: "center",
					caption: "远程图",
				},
			},
		}),
	);
	assert.equal(result.issues.length, 0);
	assert.match(
		result.markdown,
		/src="https:\/\/example.test\/a.png\?x=1&amp;y=2"/,
	);
	assert.match(
		result.markdown,
		/<span class="blq-image-caption">远程图<\/span>/,
	);
	const invalid = await convertNote(
		note(markdown, {
			imageLayouts: {
				[image.key]: { width: '1" onload="alert(1)', unit: "px" },
			},
		}),
	);
	assert.ok(
		invalid.issues.some(
			(issue) => issue.code === "image-layout" && issue.severity === "error",
		),
	);
	assert.ok(!invalid.markdown.includes("onload"));
});

test("multiline captions stay plain text rather than introducing Markdown images", async () => {
	const { createMarkdownProcessor, parseFrontmatter } = await import(
		"@astrojs/markdown-remark"
	);
	const markdown = "![remote](https://example.test/a.png)";
	const [image] = listImages(markdown);
	const result = await convertNote(
		note(markdown, {
			imageLayouts: {
				[image.key]: {
					width: 50,
					caption: "段一\n\n![caption](https://example.test/not-an-image.png)",
				},
			},
		}),
	);
	const processor = await createMarkdownProcessor({
		syntaxHighlight: false,
		smartypants: false,
	});
	const rendered = (
		await processor.render(parseFrontmatter(result.markdown).content)
	).code;
	assert.equal((rendered.match(/<img /g) || []).length, 1);
	assert.ok(
		sanitizeHtml(rendered, { allowedTags: [], allowedAttributes: {} }).includes(
			"![caption](https://example.test/not-an-image.png)",
		),
	);
	assert.equal((rendered.match(/<p>/g) || []).length, 1);
});

for (const { name, markdown, container } of [
	{
		name: "list item",
		markdown: "- before ![x](https://example.test/x.png) after\n- second item",
		container: /<li>([\s\S]*?)<\/li>/,
	},
	{
		name: "blockquote",
		markdown:
			"> before ![x](https://example.test/x.png) after\n\nOutside quote",
		container: /<blockquote>([\s\S]*?)<\/blockquote>/,
	},
	{
		name: "table cell",
		markdown:
			"| Image | Other |\n|---|---|\n| before ![x\\|label](https://example.test/x.png) after | second cell |",
		container: /<td>([\s\S]*?)<\/td>/,
	},
]) {
	test(`explicit image layouts preserve surrounding text inside a ${name}`, async () => {
		const { createMarkdownProcessor, parseFrontmatter } = await import(
			"@astrojs/markdown-remark"
		);
		const [image] = listImages(markdown);
		const result = await convertNote(
			note(markdown, {
				imageLayouts: {
					[image.key]: { width: 50, caption: "caption | **literal**" },
				},
			}),
		);
		const processor = await createMarkdownProcessor({
			syntaxHighlight: false,
			smartypants: false,
		});
		const rendered = (
			await processor.render(parseFrontmatter(result.markdown).content)
		).code;
		const content = container.exec(rendered)?.[1];
		assert.ok(content, `missing ${name}: ${rendered}`);
		assert.ok(content.includes("before"));
		assert.ok(
			content.includes('class="blq-image-layout"'),
			`image escaped its ${name}: ${rendered}`,
		);
		assert.ok(
			content.includes("after"),
			`following text escaped its ${name}: ${rendered}`,
		);
		assert.equal((content.match(/<img /g) || []).length, 1);
		assert.ok(
			!content.includes("<strong>"),
			`caption became Markdown: ${rendered}`,
		);
		if (name === "table cell")
			assert.equal((rendered.match(/<td>/g) || []).length, 2);
	});
}

test("layout normalization preserves an optional positive occurrence count", () => {
	assert.deepEqual(
		imageLayout.normalizeLayout({ width: 50, occurrenceCount: 2 }),
		{ width: 50, unit: "%", align: "center", caption: "", occurrenceCount: 2 },
	);
	for (const occurrenceCount of [
		0,
		-1,
		1.5,
		"2",
		null,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		assert.throws(
			() => imageLayout.normalizeLayout({ width: 50, occurrenceCount }),
			/引用|次数|正整数/,
		);
	}
});

test("removing one identical image warns and does not transfer its earlier occurrence caption", async (t) => {
	const dir = await temporary(t);
	const image = await fixtureImage(dir);
	const markdown = "![图](照片%20空格.png)\n\n![图](照片%20空格.png)";
	const images = listImages(markdown);
	const imageLayouts = {
		[images[0].key]: { width: 50, caption: "caption-A", occurrenceCount: 2 },
		[images[1].key]: { width: 75, caption: "caption-B", occurrenceCount: 2 },
	};
	const source = note(markdown, {
		vaultRoot: dir,
		resolutions: { "照片 空格.png": { path: image, kind: "image" } },
		imageLayouts,
	});
	const before = await convertNote(source);
	assert.ok(before.markdown.includes("caption-A"));
	assert.ok(before.markdown.includes("caption-B"));
	const removedFirst = await convertNote({
		...source,
		markdown: "![图](照片%20空格.png)",
	});
	assert.ok(!removedFirst.markdown.includes("caption-A"));
	assert.ok(!removedFirst.markdown.includes("caption-B"));
	assert.ok(!removedFirst.markdown.includes("blq-image-layout"));
	assert.ok(
		removedFirst.issues.some(
			(issue) =>
				issue.severity === "warning" &&
				issue.message === "同一图片引用数量有变化，请重新核对图片排版",
		),
	);
	const legacy = await convertNote({
		...source,
		markdown: "![图](照片%20空格.png)",
		imageLayouts: { [images[0].key]: { width: 50, caption: "legacy-caption" } },
	});
	assert.ok(legacy.markdown.includes("legacy-caption"));
	assert.equal(legacy.issues.length, 0);
});
