import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMarkdownProcessor,
	parseFrontmatter,
} from "@astrojs/markdown-remark";
import { prepareImage } from "./obsidian-publisher/assets.mjs";
import { assertInside, html } from "./obsidian-publisher/common.mjs";

export async function migrateArticle(source, file, root) {
	const { content, frontmatter } = parseFrontmatter(source);
	if (frontmatter.draft) return { text: source, files: {}, images: 0 };
	const nodes = [];
	const definitions = new Map();
	function capture() {
		return (tree) => {
			function walk(node, linked = false) {
				if (node.type === "definition")
					definitions.set(node.identifier, node.url);
				if (["image", "imageReference"].includes(node.type) && !linked)
					nodes.push(node);
				for (const child of node.children || [])
					walk(child, linked || ["link", "linkReference"].includes(node.type));
			}
			walk(tree);
		};
	}
	const processor = await createMarkdownProcessor({ remarkPlugins: [capture] });
	await processor.render(content);
	const files = {};
	const edits = [];
	for (const node of nodes) {
		const url = node.url ?? definitions.get(node.identifier);
		if (!url || /^(?:[a-z]+:|\/)/i.test(url)) continue;
		const asset = await prepareImage({
			sourcePath: assertInside(
				root,
				path.resolve(path.dirname(file), decodeURIComponent(url)),
			),
			vaultRoot: root,
			id: "legacy-images",
		});
		Object.assign(files, asset.files);
		const label = html(node.alt || "图片");
		const image = `<a class="blq-lightbox no-styling" href="${asset.originalUrl}" data-no-swup data-fancybox="blq-images" data-type="image" aria-label="放大图片：${label}"><img class="blq-image" src="${asset.displayUrl}" alt="${html(node.alt || "")}" width="${asset.width}" height="${asset.height}" loading="lazy" decoding="async"></a>`;
		const text = node.alt?.trim()
			? `<figure>${image}<figcaption>${html(node.alt)}</figcaption></figure>`
			: image;
		edits.push({
			start: node.position.start.offset,
			end: node.position.end.offset,
			text,
		});
	}
	let body = content;
	for (const edit of edits.sort((a, b) => b.start - a.start))
		body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
	if (!source.endsWith(content)) throw Error("无法保留文章顶部属性");
	return {
		text: source.slice(0, source.length - content.length) + body,
		files,
		images: edits.length,
	};
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const root = process.cwd();
	const jobs = [];
	async function scan(dir) {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if ([".obsidian", "obsidian"].includes(entry.name)) continue;
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) await scan(file);
			else if (entry.name.endsWith(".md")) {
				const result = await migrateArticle(
					await fs.readFile(file, "utf8"),
					file,
					root,
				);
				if (result.images) jobs.push({ file, ...result });
			}
		}
	}
	await scan(path.join(root, "src/content/posts"));
	const assets = Object.assign({}, ...jobs.map((job) => job.files));
	if (process.argv.includes("--apply")) {
		for (const [name, bytes] of Object.entries(assets)) {
			const file = assertInside(root, path.join(root, name));
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, bytes);
		}
		for (const job of jobs) await fs.writeFile(job.file, job.text);
	}
	console.log(
		JSON.stringify({
			articles: jobs.map(({ file, images }) => ({ file, images })),
			files: Object.keys(assets).length,
			bytes: Object.values(assets).reduce(
				(sum, bytes) => sum + bytes.length,
				0,
			),
			applied: process.argv.includes("--apply"),
		}),
	);
}
