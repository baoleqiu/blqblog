import fs from "node:fs/promises";
import path from "node:path";
import { assertInside, hash, writeAtomic } from "./common.mjs";

const digestCache = new Map();
const roots = new Set(["src", "public", "scripts", "patches"]);
const rootFile = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|pagefind\.yml|vercel\.json|wrangler\.jsonc|\.npmrc|astro\.config\..+|tsconfig.*\.json|svelte\.config\..+|tailwind\.config\..+|postcss\.config\..+)$/;
export async function sourceFiles(repoRoot) {
	const result = [];
	async function walk(directory, prefix) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (!prefix && !(roots.has(entry.name) || rootFile.test(entry.name))) continue;
			if (relative === "scripts/obsidian-publisher") continue;
			if (entry.isSymbolicLink()) throw Error(`预览文件不能使用符号链接：${relative}`);
			if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
			else if (entry.isFile()) result.push(relative);
		}
	}
	await walk(repoRoot, ""); return result.sort();
}
async function digest(file) {
	const stat = await fs.stat(file), key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	const cached = digestCache.get(file); if (cached?.key === key) return cached.hash;
	const value = hash(await fs.readFile(file)); digestCache.set(file, { key, hash: value }); return value;
}
export async function themeFingerprint(repoRoot) {
	const entries = [];
	for (const name of await sourceFiles(repoRoot)) entries.push([name, await digest(path.join(repoRoot, name))]);
	return hash(JSON.stringify(entries));
}
export async function syncWorkspace(repoRoot, workspaceRoot, overlay = {}, deleted = []) {
	assertInside(path.join(repoRoot, "cache"), workspaceRoot);
	await fs.mkdir(workspaceRoot, { recursive: true });
	const realRepo = await fs.realpath(repoRoot), realWorkspace = await fs.realpath(workspaceRoot);
	assertInside(path.join(realRepo, "cache"), realWorkspace);
	const manifestPath = path.join(workspaceRoot, ".publisher-files.json");
	let previous = {}; try { previous = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch (e) { if(e.code !== "ENOENT") throw e; }
	const next = {}, sourceHashes = [], deletion = new Set(deleted);
	for (const name of Object.keys(overlay)) assertInside(workspaceRoot, path.resolve(workspaceRoot, name));
	for (const name of await sourceFiles(repoRoot)) {
		const source = path.join(repoRoot, name), fingerprint = await digest(source);
		sourceHashes.push([name, fingerprint]);
		if (deletion.has(name) || Object.hasOwn(overlay, name)) continue;
		next[name] = fingerprint;
		if (previous[name] !== fingerprint || !(await fs.stat(path.join(workspaceRoot, name)).catch(() => null))) {
			const destination = assertInside(workspaceRoot, path.join(workspaceRoot, name));
			await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination);
		}
	}
	for (const [name, bytes] of Object.entries(overlay)) {
		next[name] = hash(bytes);
		if (previous[name] !== next[name]) await writeAtomic(assertInside(workspaceRoot, path.join(workspaceRoot, name)), bytes);
	}
	for (const name of Object.keys(previous)) if (!Object.hasOwn(next, name)) await fs.rm(assertInside(workspaceRoot, path.join(workspaceRoot, name)), { force: true });
	await writeAtomic(manifestPath, JSON.stringify(next));
	return { themeHash: hash(JSON.stringify(sourceHashes)) };
}
