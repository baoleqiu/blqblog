const path = require("node:path");
const { fromMarkdown } = require("mdast-util-from-markdown");
const remarkMath = require("remark-math").default;
const parserData = {};
remarkMath.call({ data: () => parserData });
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function decode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function localTarget(value) {
	return value && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
}
function cleanTarget(value) {
	return decode(String(value || "").split("#")[0]);
}
function resolveFile(app, value, sourcePath) {
	if (!localTarget(value)) return null;
	const target = cleanTarget(value);
	if (!target) return null;
	// A leading slash is explicitly vault-root relative, never filesystem-root.
	if (target.startsWith("/"))
		return app.vault.getAbstractFileByPath(target.replace(/^\/+/, "")) || null;
	return app.metadataCache.getFirstLinkpathDest(target, sourcePath) || null;
}
function rootReference(filePath) {
	return `/${filePath.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`;
}
function referenceRanges(markdown) {
	const source = String(markdown);
	const fm =
		/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(
			source,
		);
	const input =
		fm?.index === 0
			? fm[0].replace(/[^\r\n]/g, " ") + source.slice(fm[0].length)
			: source;
	const tree = fromMarkdown(input, {
		extensions: parserData.micromarkExtensions,
		mdastExtensions: parserData.fromMarkdownExtensions,
	});
	const ranges = [];
	const protectedRanges = [];
	function destination(start, end, definition) {
		let cursor = definition
			? source.indexOf("]:", start) + 2
			: source.lastIndexOf("](", end) + 2;
		if (cursor < start + 2) return;
		while (/\s/.test(source[cursor] || "") && cursor < end) cursor++;
		const angle = source[cursor] === "<";
		if (angle) cursor++;
		const offset = cursor;
		let depth = 0;
		while (cursor < end) {
			const char = source[cursor];
			if (char === "\\") {
				cursor += 2;
				continue;
			}
			if (
				angle ? char === ">" : /\s/.test(char) || (char === ")" && depth === 0)
			)
				break;
			if (char === "(") depth++;
			if (char === ")") depth--;
			cursor++;
		}
		if (cursor > offset)
			ranges.push({
				start: offset,
				end: cursor,
				target: source.slice(offset, cursor).replace(/\\([\\()])/g, "$1"),
				wiki: false,
			});
	}
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
				"image",
				"definition",
			].includes(node.type)
		)
			protectedRanges.push([start, end]);
		if (["image", "link", "definition"].includes(node.type))
			destination(start, end, node.type === "definition");
		for (const child of node.children || []) walk(child);
	}
	walk(tree);
	for (const match of input.matchAll(/!?\[\[([^\]\r\n]+)\]\]/g)) {
		const start = match.index;
		let backslashes = 0;
		for (
			let cursor = start;
			cursor > 0 && source[cursor - 1] === "\\";
			cursor--
		)
			backslashes++;
		if (
			backslashes % 2 ||
			protectedRanges.some(([a, b]) => start < b && start + match[0].length > a)
		)
			continue;
		const offset = start + match[0].indexOf("[[") + 2;
		const target = match[1].split("|")[0];
		ranges.push({
			start: offset,
			end: offset + target.length,
			target,
			wiki: true,
		});
	}
	return ranges;
}
function moveReferences(markdown, sourcePath, app) {
	const edits = referenceRanges(markdown).flatMap((range) => {
		if (!localTarget(range.target)) return [];
		const file = resolveFile(app, range.target, sourcePath);
		if (!file?.path) return [];
		const hashIndex = range.target.indexOf("#");
		const anchor = hashIndex < 0 ? "" : range.target.slice(hashIndex);
		return [
			{
				...range,
				replacement:
					(range.wiki ? file.path : rootReference(file.path)) + anchor,
			},
		];
	});
	let result = markdown;
	for (const edit of edits.sort((a, b) => b.start - a.start))
		result =
			result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	return result;
}
function safeName(value, fallback = "博客稿") {
	const name = path.posix
		.basename(String(value || "").replaceAll("\\", "/"))
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Windows file names cannot contain C0 characters.
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/[. ]+$/g, "")
		.trim()
		.slice(0, 100);
	return !name || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name)
		? fallback
		: name;
}
function safeVaultPath(value) {
	const normalized = String(value || "").replaceAll("\\", "/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[a-z]:/i.test(normalized) ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject C0 characters in vault paths.
		/[\u0000-\u001f]/.test(normalized) ||
		normalized.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw Error("笔记库文件路径无效。");
	return normalized;
}
async function ensureFolders(vault, folder) {
	let current = "";
	for (const part of safeVaultPath(folder).split("/")) {
		current += `${current ? "/" : ""}${part}`;
		if (!vault.getAbstractFileByPath(current)) {
			try {
				await vault.createFolder(current);
			} catch (error) {
				if (!vault.getAbstractFileByPath(current)) throw error;
			}
		}
	}
}
function imageExtension(bytes) {
	if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
		return "png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
		return "gif";
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	)
		return "webp";
	if (
		bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
		/avif|avis/.test(bytes.subarray(8, 32).toString("ascii"))
	)
		return "avif";
	throw Error("无法识别图片，请选择 PNG、JPG、WebP、GIF 或 AVIF 图片。");
}
module.exports = {
	MAX_IMAGE_BYTES,
	cleanTarget,
	resolveFile,
	rootReference,
	referenceRanges,
	moveReferences,
	safeName,
	safeVaultPath,
	ensureFolders,
	imageExtension,
};
