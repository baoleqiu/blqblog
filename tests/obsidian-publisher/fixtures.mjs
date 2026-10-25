import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
export async function temporary(t, prefix = "case-") {
	const root = path.resolve("cache/obsidian-publisher-tests");
	await fs.mkdir(root, { recursive: true });
	const dir = await fs.mkdtemp(path.join(root, prefix));
	t.after(async () => { if (!dir.startsWith(root + path.sep)) throw Error("invalid test cleanup"); await fs.rm(dir, { recursive: true, force: true }); });
	return dir;
}
export async function fixtureImage(dir, name = "照片 空格.png", color = { r: 255, g: 0, b: 0, alpha: 0.5 }) {
	const file = path.join(dir, name);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await sharp({ create: { width: 80, height: 40, channels: 4, background: color } }).png().toFile(file);
	return file;
}
export function note(markdown, extras = {}) {
	return { id: "test-article-1234", sourcePath: "实验/文章.md", vaultRoot: "", markdown, metadata: { title: "小鼠脾脏 CD8", category: "实验记录", tags: ["免疫学"], published: "2026-01-01" }, resolutions: {}, publishedLinks: {}, ...extras };
}
