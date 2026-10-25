import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import model from "../../integrations/obsidian-blog-publisher/src/model.cjs";

export const hash = (data) =>
	crypto.createHash("sha256").update(data).digest("hex");
export const validateMetadata = model.normalizeMetadata;
export function validateId(id) {
	if (!model.ID_PATTERN.test(id || "")) throw Error("文章标识无效。");
}
export function assertInside(root, target) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw Error("文件越界：必须位于指定目录内。");
	return target;
}
export const html = (text) =>
	String(text).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
export async function writeAtomic(file, text) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(`${file}.tmp`, text);
	await fs.rename(`${file}.tmp`, file);
}
