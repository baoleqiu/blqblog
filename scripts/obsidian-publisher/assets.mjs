import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assertInside, hash, validateId } from "./common.mjs";

export async function prepareVideo({ sourcePath, vaultRoot, id }) {
	validateId(id);
	const root = await fs.realpath(vaultRoot);
	const source = await fs.realpath(sourcePath);
	assertInside(root, source);
	if (path.extname(source).toLowerCase() !== ".mp4")
		throw Error("目前支持 MP4 视频。");
	const limit = 100 * 1024 * 1024;
	const sizeError = () =>
		Error(
			"视频超过 GitHub 普通文件的 100 MiB 限制，请先缩小视频或使用外部视频链接。",
		);
	if ((await fs.stat(source)).size > limit) throw sizeError();
	const bytes = await fs.readFile(source);
	if (bytes.length > limit) throw sizeError();
	const digest = hash(bytes);
	const originalUrl = `/obsidian-published/${id}/originals/${digest}.mp4`;
	return {
		kind: "video",
		originalUrl,
		displayUrl: originalUrl,
		files: { [`public${originalUrl}`]: bytes },
		hash: digest,
		sourcePath: source,
	};
}

export async function prepareImage({ sourcePath, vaultRoot, id }) {
	validateId(id);
	const root = await fs.realpath(vaultRoot);
	const source = await fs.realpath(sourcePath);
	assertInside(root, source);
	const extension = path.extname(source).slice(1).toLowerCase();
	if (!["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension))
		throw Error(
			`暂不支持 ${extension || "此类型"} 图片，请使用 JPG、PNG、WebP、GIF 或 AVIF。`,
		);
	const bytes = await fs.readFile(source);
	const digest = hash(bytes);
	const metadata = await sharp(bytes).metadata();
	const originalUrl = `/obsidian-published/${id}/originals/${digest}.${extension}`;
	const files = { [`public${originalUrl}`]: bytes };
	let displayUrl = originalUrl;
	const rotated = [5, 6, 7, 8].includes(metadata.orientation);
	let width = rotated ? metadata.height : metadata.width;
	let height = rotated ? metadata.width : metadata.height;
	const small = bytes.length <= 300 * 1024 && Math.max(width, height) <= 1920;
	if (extension !== "gif" && !small) {
		const result = await sharp(bytes)
			.rotate()
			.resize({
				width: 1920,
				height: 1920,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality: 90, lossless: extension === "png" || metadata.hasAlpha })
			.toBuffer({ resolveWithObject: true });
		if (result.data.length < bytes.length) {
			displayUrl = `/obsidian-published/${id}/display/${digest}.webp`;
			files[`public${displayUrl}`] = result.data;
			width = result.info.width;
			height = result.info.height;
		}
	}
	return {
		originalUrl,
		displayUrl,
		files,
		hash: digest,
		width,
		height,
		sourcePath: source,
	};
}
