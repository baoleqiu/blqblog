import path from "node:path";
import { createMarkdownProcessor, parseFrontmatter } from "@astrojs/markdown-remark";
import remarkMath from "remark-math";
import katex from "katex";
import "katex/dist/contrib/mhchem.mjs";
import model from "../../integrations/obsidian-blog-publisher/src/model.cjs";
import { hash, html, validateId, validateMetadata } from "./common.mjs";
import { prepareImage } from "./assets.mjs";

const markdownText = text => String(text).replace(/[\\`*_[\]<>]/g, "\\$&");
const decode = text => { try { return decodeURIComponent(text); } catch { return text; } };
export async function convertNote(snapshot) {
	validateId(snapshot.id);
	const issues = [], files = {}, assets = [], edits = [], protectedRanges = [], imageNodes = [], definitions = new Map();
	let body = String(snapshot.markdown), metadata;
	const issue = (severity, code, message, offset = 0) => issues.push({ severity, code, message, line: body.slice(0, offset).split("\n").length });
	try { body = parseFrontmatter(body).content; } catch { issue("error", "frontmatter", "原笔记顶部属性格式无法解析。"); }
	try { metadata = validateMetadata(snapshot.metadata); } catch (error) { issue("error", "metadata", error.message); metadata = { title: "待填写标题", tags: [], ...snapshot.metadata }; }
	metadata.published ||= model.today();
	function capture() { return tree => {
		function walk(node) {
			const start = node.position?.start.offset, end = node.position?.end.offset;
			if (["code", "inlineCode", "math", "inlineMath", "html"].includes(node.type)) protectedRanges.push([start, end]);
			if (node.type === "code" && /^(dataview|dataviewjs|tasks)$/i.test(node.lang || "")) issue("error", "dynamic-query", "动态查询不能直接发布，请先整理成普通正文。", start);
			if (node.type === "inlineCode" && /^\s*(=|\$=)/.test(node.value)) issue("error", "dynamic-query", "行内动态查询需要先转成普通文字。", start);
			if (node.type === "math" || node.type === "inlineMath") {
				try { katex.renderToString(node.value, { throwOnError: true, trust: false, displayMode: node.type === "math" }); }
				catch { issue("error", "math", "公式无法正确渲染，请检查命令和括号。", start); }
			}
			if (node.type === "image" || node.type === "imageReference") imageNodes.push(node);
			if (node.type === "definition") definitions.set(node.identifier, node.url);
			for (const child of node.children || []) walk(child);
		}
		walk(tree);
	}; }
	const processor = await createMarkdownProcessor({ syntaxHighlight: false, smartypants: false, remarkPlugins: [remarkMath, capture] });
	await processor.render(body);
	const escaped = offset => { let count = 0; while (offset > 0 && body[--offset] === "\\") count++; return count % 2; };
	const protectedAt = (start, end) => escaped(start) || protectedRanges.some(([a, b]) => start < b && end > a) || edits.some(e => start < e.end && end > e.start);
	const resolve = target => snapshot.resolutions?.[decode(target)] || snapshot.resolutions?.[target];
	const exported = new Map();
	async function exportImage(target, offset) {
		const resolution = resolve(target);
		if (!resolution?.path) { issue("error", "missing-asset", `找不到附件：${target}`, offset); return null; }
		if (exported.has(resolution.path)) return exported.get(resolution.path);
		try {
			const asset = await prepareImage({ sourcePath: resolution.path, vaultRoot: snapshot.vaultRoot, id: snapshot.id });
			exported.set(resolution.path, asset);
			if (!assets.some(a => a.originalUrl === asset.originalUrl)) { assets.push(asset); Object.assign(files, asset.files); }
			return asset;
		} catch (error) { issue("error", "asset", `附件 ${target}：${error.message}`, offset); return null; }
	}
	async function imageMarkup(target, alt, size, offset) {
		if (/^https?:\/\//i.test(target)) return null;
		const asset = await exportImage(target, offset); if (!asset) return null;
		const requested = /^(\d+)(?:x(\d+))?$/.exec(size || "");
		const width = requested ? Math.min(10000, Math.max(1, +requested[1])) : asset.width;
		const height = requested?.[2] ? Math.min(10000, Math.max(1, +requested[2])) : Math.round(asset.height * width / asset.width);
		return `<img src="${asset.displayUrl}" alt="${html(alt)}" width="${width}" height="${height}" loading="lazy" decoding="async"> <a href="${asset.originalUrl}" target="_blank" rel="noopener noreferrer">查看原图</a>`;
	}
	for (const node of imageNodes) {
		const start = node.position.start.offset, end = node.position.end.offset;
		const target = node.url ?? definitions.get(node.identifier);
		if (!target) { issue("error", "missing-asset", "图片引用没有对应的链接定义。", start); continue; }
		const replacement = await imageMarkup(target, node.alt || "", "", start);
		if (replacement) edits.push({ start, end, text: replacement });
		protectedRanges.push([start, end]);
	}
	for (const match of body.matchAll(/(!?)\[\[([^\]\r\n]+)\]\]/g)) {
		const start = match.index, end = start + match[0].length;
		if (protectedAt(start, end)) continue;
		const [rawTarget, ...aliases] = match[2].split("|"), alias = aliases.join("|");
		const [target, anchor] = rawTarget.split("#"), resolution = resolve(target);
		if (match[1]) {
			if (resolution?.kind === "note" || !path.extname(target) || /\.md$/i.test(target)) { issue("error", "note-embed", `暂不支持嵌入整篇笔记：${target}。请把需要的正文整理到当前笔记。`, start); continue; }
			const replacement = await imageMarkup(target, /^\d+(x\d+)?$/.test(alias) ? "" : alias, alias, start);
			if (replacement) edits.push({ start, end, text: replacement });
		} else {
			const label = markdownText(alias || rawTarget), url = snapshot.publishedLinks?.[resolution?.notePath];
			if (url && /^\/posts\/[a-zA-Z0-9/%_.~-]+\/$/.test(url)) {
				edits.push({ start, end, text: `[${label}](${url})` });
				if (anchor) issue("warning", "anchor-fallback", `链接 ${rawTarget} 将打开文章首页。`, start);
			} else { edits.push({ start, end, text: label }); issue("warning", "unpublished-link", `未发布的笔记链接将显示为文字：${target}`, start); }
		}
	}
	for (const match of body.matchAll(/==([^=\r\n]+)==/g)) {
		const start = match.index, end = start + match[0].length;
		if (!protectedAt(start, end)) edits.push({ start, end, text: `<mark>${html(match[1])}</mark>` });
	}
	let image = "";
	if (metadata.cover) {
		if (/^https?:\/\//i.test(metadata.cover)) image = metadata.cover;
		else image = (await exportImage(metadata.cover, 0))?.displayUrl || "";
	}
	let converted = body;
	for (const edit of edits.sort((a, b) => b.start - a.start)) converted = converted.slice(0, edit.start) + edit.text + converted.slice(edit.end);
	const fields = { title: metadata.title, published: metadata.published, description: metadata.description || "", category: metadata.category || "", tags: metadata.tags || [], image, draft: false };
	const markdown = `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${converted}`;
	files[`src/content/posts/obsidian/${snapshot.id}/index.md`] = markdown;
	const contentFingerprint = hash(JSON.stringify({ rules: 1, markdown, assets: assets.map(a => a.hash).sort(), issues }));
	return { id: snapshot.id, articleUrl: `/posts/obsidian/${snapshot.id}/`, markdown, metadata, assets, issues, contentFingerprint, fingerprint: contentFingerprint, files };
}
