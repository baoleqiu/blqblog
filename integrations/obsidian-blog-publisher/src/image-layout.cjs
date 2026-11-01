const crypto = require("node:crypto");
const { fromMarkdown } = require("mdast-util-from-markdown");
const remarkMath = require("remark-math").default;

// Reuse remark-math's parser extensions so the inventory and publishing parser
// agree about both inline and block formulas.
const parserData = {};
remarkMath.call({ data: () => parserData });

function normalizeLayout(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value))
		throw Error("图片排版设置无效。");
	const unit = value.unit ?? "%";
	if (!["%", "px"].includes(unit))
		throw Error("图片宽度单位只能是百分比或像素。");
	const raw = value.width;
	if (
		(typeof raw !== "number" && typeof raw !== "string") ||
		(typeof raw === "string" && !/^\d+(?:\.\d+)?$/.test(raw.trim()))
	)
		throw Error("图片宽度必须是有效数字。");
	const width = Number(raw);
	if (
		!Number.isFinite(width) ||
		width < 1 ||
		width > (unit === "%" ? 100 : 10000)
	)
		throw Error(
			unit === "%" ? "图片宽度应为 1–100%。" : "图片宽度应为 1–10000 像素。",
		);
	const align = value.align ?? "center";
	if (!["left", "center", "right"].includes(align))
		throw Error("图片对齐方式无效。");
	const caption = value.caption ?? "";
	if (typeof caption !== "string") throw Error("图片图注必须是文字。");
	const layout = { width, unit, align, caption };
	if (value.occurrenceCount !== undefined) {
		if (
			!Number.isSafeInteger(value.occurrenceCount) ||
			value.occurrenceCount < 1
		)
			throw Error("图片引用次数必须为正整数。");
		layout.occurrenceCount = value.occurrenceCount;
	}
	return layout;
}

function listImages(markdown) {
	const source = String(markdown ?? "");
	const frontmatter =
		/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(
			source,
		);
	const input =
		frontmatter?.index === 0
			? frontmatter[0].replace(/[^\r\n]/g, " ") +
				source.slice(frontmatter[0].length)
			: source;
	const tree = fromMarkdown(input, {
		extensions: parserData.micromarkExtensions,
		mdastExtensions: parserData.fromMarkdownExtensions,
	});
	const definitions = new Map();
	const nodes = [];
	const protectedRanges = [];
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
				"definition",
				"link",
				"linkReference",
				"image",
				"imageReference",
			].includes(node.type)
		)
			protectedRanges.push([start, end]);
		if (node.type === "definition" && !definitions.has(node.identifier))
			definitions.set(node.identifier, node.url);
		if (node.type === "image" || node.type === "imageReference")
			nodes.push(node);
		for (const child of node.children || []) walk(child);
	}
	walk(tree);
	const images = nodes.flatMap((node) => {
		const target = node.url ?? definitions.get(node.identifier);
		if (!target) return [];
		return [
			{
				target,
				alt: node.alt || "",
				size: "",
				start: node.position.start.offset,
				end: node.position.end.offset,
				line: node.position.start.line,
			},
		];
	});
	const escaped = (offset) => {
		let count = 0;
		let cursor = offset;
		while (cursor > 0 && source[--cursor] === "\\") count++;
		return count % 2;
	};
	for (const match of input.matchAll(/!\[\[([^\]\r\n]+)\]\]/g)) {
		const start = match.index;
		const end = start + match[0].length;
		if (
			escaped(start) ||
			protectedRanges.some(([a, b]) => start < b && end > a)
		)
			continue;
		const [rawTarget, ...aliases] = match[1].split("|");
		const target = rawTarget.split("#")[0];
		if (!/\.[^./\\]+$/.test(target) || /\.md$/i.test(target)) continue;
		const alias = aliases.join("|");
		const sized = /^\d+(?:x\d+)?$/.test(alias);
		images.push({
			target,
			alt: sized ? "" : alias,
			size: sized ? alias : "",
			start,
			end,
			line: source.slice(0, start).split("\n").length,
		});
	}
	const counts = new Map();
	return images
		.sort((a, b) => a.start - b.start)
		.map((image) => {
			// Source offsets and surrounding prose are intentionally absent: editing text
			// or inserting a different image must not detach saved settings.
			const identity = crypto
				.createHash("sha256")
				.update(JSON.stringify([image.target, image.alt, image.size]))
				.digest("hex")
				.slice(0, 24);
			const occurrence = (counts.get(identity) || 0) + 1;
			counts.set(identity, occurrence);
			return { key: `image-${identity}-${occurrence}`, ...image };
		});
}

module.exports = { listImages, normalizeLayout };
