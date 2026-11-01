const { randomUUID } = require("node:crypto");
const { normalizeLayout } = require("./image-layout.cjs");

const VERSION = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,79}$/;
const pathKey = (value) =>
	String(value || "")
		.replaceAll("\\", "/")
		.replace(/\/+$/, "")
		.toLowerCase();
const clone = (value) => JSON.parse(JSON.stringify(value));
function today() {
	const date = new Date();
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function createState(settings = {}) {
	return {
		version: VERSION,
		settings: {
			vaultRoot: "",
			repoPath: "",
			nodePath: "node",
			gitPath: "git",
			siteUrl: "https://blqblog.cn",
			productionBranch: "",
			productionConfirmed: false,
			...settings,
		},
		records: [],
	};
}
function normalizeMetadata(input = {}, currentDate = today()) {
	const title = String(input.title ?? "").trim();
	if (!title) throw Error("请填写文章标题。");
	const published =
		input.published instanceof Date
			? input.published.toISOString().slice(0, 10)
			: String(input.published || "").trim();
	if (published) {
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(published) ||
			Number.isNaN(Date.parse(`${published}T00:00:00Z`)) ||
			new Date(`${published}T00:00:00Z`).toISOString().slice(0, 10) !==
				published
		)
			throw Error("发布日期无效，请使用 YYYY-MM-DD。");
		if (published > currentDate)
			throw Error("第一版不支持未来日期的定时发布。");
	}
	const rawTags = Array.isArray(input.tags)
		? input.tags
		: String(input.tags || "").split(/[,，\n]/);
	return {
		title,
		category: String(input.category || "").trim(),
		tags: [
			...new Set(
				rawTags.map((x) => String(x).trim().replace(/^#+/, "")).filter(Boolean),
			),
		],
		description: String(input.description || "").trim(),
		cover: String(input.cover || "").trim(),
		published,
	};
}
function sourceDefaults(frontmatter = {}, basename = "新文章") {
	return {
		title: String(frontmatter.title || basename),
		category:
			typeof frontmatter.category === "string" ? frontmatter.category : "",
		tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
		description:
			typeof frontmatter.description === "string"
				? frontmatter.description
				: "",
		cover: typeof frontmatter.image === "string" ? frontmatter.image : "",
		published:
			typeof frontmatter.published === "string" ? frontmatter.published : "",
	};
}
function bindNote(state, note) {
	if (!note.path || !/\.md$/i.test(note.path))
		throw Error("请选择 Markdown 笔记。");
	const existing = state.records.find(
		(r) =>
			pathKey(r.sourcePath) === pathKey(note.path) ||
			(r.draftPath && pathKey(r.draftPath) === pathKey(note.path)),
	);
	if (existing) {
		if (existing.draftPath) existing.contentMode = "draft";
		if (pathKey(existing.draftPath) === pathKey(note.path))
			existing.draftMissing = false;
		else existing.sourceMissing = false;
		return existing;
	}
	const id = randomUUID();
	const record = {
		id,
		sourcePath: note.path,
		blogPath: `/posts/obsidian/${id}/`,
		metadata: sourceDefaults(
			note.frontmatter,
			note.basename || note.path.split(/[\\/]/).pop().replace(/\.md$/i, ""),
		),
		status: "draft",
		sourceMissing: false,
		lastPublished: null,
		operation: null,
	};
	state.records.push(record);
	return record;
}
function updateMetadata(record, patch) {
	const combined = { ...record.metadata, ...patch };
	// Empty fields are valid while typing; export performs the complete validation.
	record.metadata = { ...sourceDefaults({}, ""), ...combined };
	if (Array.isArray(combined.tags))
		record.metadata.tags = [
			...new Set(
				combined.tags
					.map((x) => String(x).trim().replace(/^#+/, ""))
					.filter(Boolean),
			),
		];
	return record;
}
function renameSource(state, oldPath, newPath) {
	const oldKey = pathKey(oldPath);
	for (const record of state.records) {
		for (const field of ["sourcePath", "draftPath"]) {
			const key = pathKey(record[field]);
			if (key && (key === oldKey || key.startsWith(`${oldKey}/`))) {
				record[field] =
					newPath.replaceAll("\\", "/") +
					record[field]
						.replaceAll("\\", "/")
						.slice(oldPath.replaceAll("\\", "/").length);
				record[field === "sourcePath" ? "sourceMissing" : "draftMissing"] =
					false;
			}
		}
	}
}
function markSourceMissing(state, sourcePath) {
	const key = pathKey(sourcePath);
	for (const record of state.records) {
		for (const field of ["sourcePath", "draftPath"]) {
			const current = pathKey(record[field]);
			if (current && (current === key || current.startsWith(`${key}/`)))
				record[field === "sourcePath" ? "sourceMissing" : "draftMissing"] =
					true;
		}
	}
}
function reconcileSources(state, exists) {
	for (const record of state.records) {
		record.sourceMissing = !exists(record.sourcePath);
		if (record.draftPath) record.draftMissing = !exists(record.draftPath);
	}
}
function relinkSource(state, id, sourcePath) {
	const record = state.records.find((r) => r.id === id);
	if (!record) throw Error("发布记录不存在。");
	if (
		state.records.some(
			(r) =>
				r.id !== id &&
				[r.sourcePath, r.draftPath].some(
					(p) => p && pathKey(p) === pathKey(sourcePath),
				),
		)
	)
		throw Error("该笔记已关联另一篇博客文章。");
	if (record.draftPath && pathKey(record.draftPath) === pathKey(sourcePath))
		throw Error("博客稿不能重新关联为原笔记。");
	if (!/\.md$/i.test(sourcePath)) throw Error("请选择 Markdown 笔记。");
	record.sourcePath = sourcePath;
	record.sourceMissing = false;
	return record;
}
function validateState(value) {
	if (!value || value.version !== VERSION)
		throw Error("发布数据版本不支持或格式无效。");
	if (!value.settings || !Array.isArray(value.records))
		throw Error("发布数据格式无效。");
	const ids = new Set();
	const sources = new Set();
	for (const record of value.records) {
		if (
			!record ||
			!ID_PATTERN.test(record.id || "") ||
			typeof record.sourcePath !== "string" ||
			!record.metadata ||
			typeof record.metadata.title !== "string" ||
			!Array.isArray(record.metadata.tags)
		)
			throw Error("文章记录格式无效。");
		if (record.blogPath !== `/posts/obsidian/${record.id}/`)
			throw Error("文章网址与标识不匹配。");
		if (
			record.contentMode !== undefined &&
			!["source", "draft"].includes(record.contentMode)
		)
			throw Error("正文来源格式无效。");
		if (record.contentMode === "draft" && !record.draftPath)
			throw Error("博客稿路径缺失。");
		if (
			record.draftPath !== undefined &&
			(typeof record.draftPath !== "string" ||
				!/\.md$/i.test(record.draftPath) ||
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject C0 characters in imported vault paths.
				/^[\\/]|^[a-z]:|[\u0000-\u001f]/i.test(record.draftPath) ||
				record.draftPath
					.replaceAll("\\", "/")
					.split("/")
					.some((part) => !part || part === "." || part === ".."))
		)
			throw Error("博客稿路径格式无效。");
		if (
			record.imageLayouts !== undefined &&
			(!record.imageLayouts ||
				typeof record.imageLayouts !== "object" ||
				Array.isArray(record.imageLayouts) ||
				Object.keys(record.imageLayouts).length > 5000 ||
				JSON.stringify(record.imageLayouts).length > 2 * 1024 * 1024 ||
				Object.entries(record.imageLayouts).some(
					([key, layout]) =>
						!key ||
						key.length > 200 ||
						(layout !== null &&
							(!layout || typeof layout !== "object" || Array.isArray(layout))),
				))
		)
			throw Error("图片排版数据格式无效。");
		for (const layout of Object.values(record.imageLayouts || {}))
			normalizeLayout(layout);
		const paths = [
			record.sourcePath,
			...(record.draftPath ? [record.draftPath] : []),
		].map(pathKey);
		if (
			ids.has(record.id) ||
			new Set(paths).size !== paths.length ||
			paths.some((key) => sources.has(key))
		)
			throw Error("文章记录存在重复或冲突。");
		ids.add(record.id);
		for (const key of paths) sources.add(key);
	}
	return clone(value);
}
function validateImport(current, incoming) {
	const valid = validateState(incoming);
	if (!current) return valid;
	if (pathKey(current.settings.vaultRoot) !== pathKey(valid.settings.vaultRoot))
		throw Error("备份来自不同笔记库，请先确认迁移路径。");
	if (pathKey(current.settings.repoPath) !== pathKey(valid.settings.repoPath))
		throw Error("备份来自不同博客目录，请先确认迁移路径。");
	const merged = clone(current);
	for (const record of valid.records) {
		const existing = merged.records.find(
			(r) =>
				r.id === record.id ||
				pathKey(r.sourcePath) === pathKey(record.sourcePath),
		);
		if (existing && JSON.stringify(existing) !== JSON.stringify(record))
			throw Error(`发布记录冲突：${record.metadata.title}。当前数据未修改。`);
		if (!existing) merged.records.push(record);
	}
	return validateState(merged);
}
module.exports = {
	VERSION,
	ID_PATTERN,
	today,
	pathKey,
	createState,
	normalizeMetadata,
	sourceDefaults,
	bindNote,
	updateMetadata,
	renameSource,
	markSourceMissing,
	reconcileSources,
	relinkSource,
	validateState,
	validateImport,
};
