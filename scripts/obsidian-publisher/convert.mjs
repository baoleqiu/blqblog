import path from "node:path";
import {
	createMarkdownProcessor,
	parseFrontmatter,
} from "@astrojs/markdown-remark";
import katex from "katex";
import remarkMath from "remark-math";
import "katex/dist/contrib/mhchem.mjs";
import model from "../../integrations/obsidian-blog-publisher/src/model.cjs";
import { prepareImage, prepareVideo } from "./assets.mjs";
import { hash, html, validateId, validateMetadata } from "./common.mjs";

const markdownText = (text) => String(text).replace(/[\\`*_[\]<>]/g, "\\$&");
const decode = (text) => {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
};
export async function convertNote(snapshot) {
	validateId(snapshot.id);
	const issues = [];
	const files = {};
	const assets = [];
	const edits = [];
	const protectedRanges = [];
	const imageNodes = [];
	const definitions = new Map();
	let body = String(snapshot.markdown);
	let metadata;
	const issue = (severity, code, message, offset = 0) =>
		issues.push({
			severity,
			code,
			message,
			line: body.slice(0, offset).split("\n").length,
		});
	try {
		body = parseFrontmatter(body).content;
	} catch {
		issue("error", "frontmatter", "原笔记顶部属性格式无法解析。");
	}
	try {
		metadata = validateMetadata(snapshot.metadata);
	} catch (error) {
		issue("error", "metadata", error.message);
		metadata = { title: "待填写标题", tags: [], ...snapshot.metadata };
	}
	metadata.published ||= model.today();
	function capture() {
		return (tree) => {
			function walk(node) {
				const start = node.position?.start.offset;
				const end = node.position?.end.offset;
				if (
					[
						"code",
						"inlineCode",
						"math",
						"inlineMath",
						"html",
						"link",
						"linkReference",
						"definition",
					].includes(node.type)
				)
					protectedRanges.push([start, end]);
				if (
					node.type === "code" &&
					/^(dataview|dataviewjs|tasks)$/i.test(node.lang || "")
				)
					issue(
						"error",
						"dynamic-query",
						"动态查询不能直接发布，请先整理成普通正文。",
						start,
					);
				if (node.type === "inlineCode" && /^\s*(=|\$=)/.test(node.value))
					issue(
						"error",
						"dynamic-query",
						"行内动态查询需要先转成普通文字。",
						start,
					);
				if (node.type === "math" || node.type === "inlineMath") {
					try {
						katex.renderToString(node.value, {
							throwOnError: true,
							trust: false,
							displayMode: node.type === "math",
						});
					} catch {
						issue(
							"error",
							"math",
							"公式无法正确渲染，请检查命令和括号。",
							start,
						);
					}
				}
				if (node.type === "image" || node.type === "imageReference")
					imageNodes.push(node);
				if (node.type === "definition")
					definitions.set(node.identifier, node.url);
				for (const child of node.children || []) walk(child);
			}
			walk(tree);
		};
	}
	const processor = await createMarkdownProcessor({
		syntaxHighlight: false,
		smartypants: false,
		remarkPlugins: [remarkMath, capture],
	});
	await processor.render(body);
	const escaped = (offset) => {
		let count = 0;
		let cursor = offset;
		while (cursor > 0 && body[--cursor] === "\\") count++;
		return count % 2;
	};
	const protectedAt = (start, end) =>
		escaped(start) ||
		protectedRanges.some(([a, b]) => start < b && end > a) ||
		edits.some((e) => start < e.end && end > e.start);
	const resolve = (target) =>
		snapshot.resolutions?.[decode(target)] || snapshot.resolutions?.[target];
	const exported = new Map();
	async function exportAsset(target, offset, allowVideo = false) {
		const resolution = resolve(target);
		if (!resolution?.path) {
			issue("error", "missing-asset", `找不到附件：${target}`, offset);
			return null;
		}
		const video = path.extname(resolution.path).toLowerCase() === ".mp4";
		if (video && !allowVideo) {
			issue("error", "asset", "封面需要图片，不能使用 MP4 视频。", offset);
			return null;
		}
		if (exported.has(resolution.path)) return exported.get(resolution.path);
		try {
			const asset = await (video ? prepareVideo : prepareImage)({
				sourcePath: resolution.path,
				vaultRoot: snapshot.vaultRoot,
				id: snapshot.id,
			});
			exported.set(resolution.path, asset);
			if (!assets.some((a) => a.originalUrl === asset.originalUrl)) {
				assets.push(asset);
				Object.assign(files, asset.files);
			}
			return asset;
		} catch (error) {
			issue("error", "asset", `附件 ${target}：${error.message}`, offset);
			return null;
		}
	}
	async function mediaMarkup(target, alt, size, offset) {
		if (/^https?:\/\//i.test(target)) return null;
		const asset = await exportAsset(target, offset, true);
		if (!asset) return null;
		const requested = /^(\d+)(?:x(\d+))?$/.exec(size || "");
		if (asset.kind === "video") {
			const dimensions = requested
				? ` width="${Math.min(10000, Math.max(1, +requested[1]))}"${requested[2] ? ` height="${Math.min(10000, Math.max(1, +requested[2]))}"` : ""}`
				: "";
			return `<video class="blq-video" src="${asset.originalUrl}" controls playsinline preload="metadata" aria-label="${html(alt || "视频")}"${dimensions}><a href="${asset.originalUrl}" target="_blank" rel="noopener noreferrer">打开原视频</a></video>`;
		}
		const width = requested
			? Math.min(10000, Math.max(1, +requested[1]))
			: asset.width;
		const height = requested?.[2]
			? Math.min(10000, Math.max(1, +requested[2]))
			: Math.round((asset.height * width) / asset.width);
		return `<img src="${asset.displayUrl}" alt="${html(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async"> <a href="${asset.originalUrl}" target="_blank" rel="noopener noreferrer">查看原图</a>`;
	}
	for (const node of imageNodes) {
		const start = node.position.start.offset;
		const end = node.position.end.offset;
		const target = node.url ?? definitions.get(node.identifier);
		if (!target) {
			issue("error", "missing-asset", "图片引用没有对应的链接定义。", start);
			continue;
		}
		const replacement = await mediaMarkup(target, node.alt || "", "", start);
		if (replacement) edits.push({ start, end, text: replacement });
		protectedRanges.push([start, end]);
	}
	for (const match of body.matchAll(/(!?)\[\[([^\]\r\n]+)\]\]/g)) {
		const start = match.index;
		const end = start + match[0].length;
		if (protectedAt(start, end)) continue;
		const [rawTarget, ...aliases] = match[2].split("|");
		const alias = aliases.join("|");
		const [target, anchor] = rawTarget.split("#");
		const resolution = resolve(target);
		if (match[1]) {
			if (
				resolution?.kind === "note" ||
				!path.extname(target) ||
				/\.md$/i.test(target)
			) {
				issue(
					"error",
					"note-embed",
					`暂不支持嵌入整篇笔记：${target}。请把需要的正文整理到当前笔记。`,
					start,
				);
				continue;
			}
			const replacement = await mediaMarkup(
				target,
				/^\d+(x\d+)?$/.test(alias) ? "" : alias,
				alias,
				start,
			);
			if (replacement) edits.push({ start, end, text: replacement });
		} else {
			const label = markdownText(alias || rawTarget);
			const url = snapshot.publishedLinks?.[resolution?.notePath];
			if (url && /^\/posts\/[a-zA-Z0-9/%_.~-]+\/$/.test(url)) {
				edits.push({ start, end, text: `[${label}](${url})` });
				if (anchor)
					issue(
						"warning",
						"anchor-fallback",
						`链接 ${rawTarget} 将打开文章首页。`,
						start,
					);
			} else {
				edits.push({ start, end, text: label });
				issue(
					"warning",
					"unpublished-link",
					`未发布的笔记链接将显示为文字：${target}`,
					start,
				);
			}
		}
	}
	let inlineProcessor;
	for (const match of body.matchAll(/==([^=\r\n]+)==/g)) {
		const start = match.index;
		const end = start + match[0].length;
		if (!protectedAt(start, end)) {
			inlineProcessor ||= await createMarkdownProcessor({
				syntaxHighlight: false,
				smartypants: false,
			});
			const inner = (await inlineProcessor.render(match[1])).code
				.trim()
				.replace(/^<p>|<\/p>$/g, "");
			edits.push({ start, end, text: `<mark>${inner}</mark>` });
		}
	}
	let image = "";
	if (metadata.cover) {
		if (/^https?:\/\//i.test(metadata.cover)) image = metadata.cover;
		else image = (await exportAsset(metadata.cover, 0))?.displayUrl || "";
	}
	let converted = body;
	for (const edit of edits.sort((a, b) => b.start - a.start))
		converted =
			converted.slice(0, edit.start) + edit.text + converted.slice(edit.end);
	const fields = {
		title: metadata.title,
		published: metadata.published,
		description: metadata.description || "",
		category: metadata.category || "",
		tags: metadata.tags || [],
		image,
		draft: false,
	};
	const serialize = () =>
		`---\n${Object.entries(fields)
			.map(
				([key, value]) =>
					`${key}: ${key === "published" || key === "updated" ? (/^\d{4}-\d{2}-\d{2}$/.test(value) && !issues.some((i) => i.code === "metadata") ? value : model.today()) : JSON.stringify(value)}`,
			)
			.join("\n")}\n---\n${converted}`;
	let markdown = serialize();
	const contentFingerprint = hash(
		JSON.stringify({
			rules: 1,
			markdown,
			assets: assets.map((a) => a.hash).sort(),
			issues,
		}),
	);
	let updated = snapshot.lastPublished?.updated || null;
	if (
		snapshot.lastPublished &&
		snapshot.lastPublished.contentFingerprint !== contentFingerprint
	)
		updated = model.today();
	if (updated) {
		fields.updated = updated;
		markdown = serialize();
	}
	files[`src/content/posts/obsidian/${snapshot.id}/index.md`] = markdown;
	return {
		id: snapshot.id,
		articleUrl: `/posts/obsidian/${snapshot.id}/`,
		markdown,
		metadata,
		assets,
		issues,
		contentFingerprint,
		fingerprint: hash(`${contentFingerprint}:${markdown}`),
		updated,
		files,
	};
}
