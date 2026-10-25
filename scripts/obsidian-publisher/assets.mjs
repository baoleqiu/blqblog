import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assertInside, hash, validateId } from "./common.mjs";

export async function prepareImage({ sourcePath, vaultRoot, id }) {
	validateId(id);
	const root = await fs.realpath(vaultRoot), source = await fs.realpath(sourcePath);
	assertInside(root, source);
	const extension = path.extname(source).slice(1).toLowerCase();
	if (!["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension)) throw Error(`暂不支持 ${extension || "此类型"} 图片，请使用 JPG、PNG、WebP、GIF 或 AVIF。`);
	const bytes = await fs.readFile(source), digest = hash(bytes);
	const metadata = await sharp(bytes).metadata();
	const originalUrl = `/obsidian-published/${id}/originals/${digest}.${extension}`;
	const files = { [`public${originalUrl}`]: bytes };
	let displayUrl = originalUrl, width = metadata.width, height = metadata.height;
	if (extension !== "gif") {
		displayUrl = `/obsidian-published/${id}/display/${digest}.webp`;
		const result = await sharp(bytes).rotate().resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true }).webp({ quality: 90, lossless: extension === "png" || metadata.hasAlpha }).toBuffer({ resolveWithObject: true });
		files[`public${displayUrl}`] = result.data; width = result.info.width; height = result.info.height;
	}
	return { originalUrl, displayUrl, files, hash: digest, width, height, sourcePath: source };
}
