import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { temporary } from "./fixtures.mjs";
let engine = {};
try {
	engine = await import("../../scripts/obsidian-publisher/workspace.mjs");
} catch (e) {
	if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
}
test("workspace mirrors theme, excludes private folders, cleans stale files and never writes source", async (t) => {
	assert.equal(typeof engine.syncWorkspace, "function");
	const root = await temporary(t),
		repo = path.join(root, "repo"),
		dest = path.join(repo, "cache/preview");
	for (const [name, value] of Object.entries({
		"src/config/theme.ts": "blue",
		"public/a.txt": "asset",
		"package.json": "{}",
		"cache/private.txt": "private",
		".git/config": "private",
		".obsidian/data.json": "private",
		"integrations/private.json": "private",
	})) {
		await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
		await fs.writeFile(path.join(repo, name), value);
	}
	const first = await engine.syncWorkspace(repo, dest, {
		"src/content/posts/candidate.md": "draft",
	});
	assert.equal(
		await fs.readFile(
			path.join(dest, "src/content/posts/candidate.md"),
			"utf8",
		),
		"draft",
	);
	await assert.rejects(
		fs.access(path.join(repo, "src/content/posts/candidate.md")),
	);
	for (const dir of ["cache", ".git", ".obsidian", "integrations"])
		await assert.rejects(fs.access(path.join(dest, dir)));
	await fs.writeFile(path.join(repo, "src/config/theme.ts"), "green");
	await fs.unlink(path.join(repo, "public/a.txt"));
	const next = await engine.syncWorkspace(repo, dest, {});
	assert.notEqual(first.themeHash, next.themeHash);
	await assert.rejects(fs.access(path.join(dest, "public/a.txt")));
	await assert.rejects(
		fs.access(path.join(dest, "src/content/posts/candidate.md")),
	);
	await assert.rejects(
		engine.syncWorkspace(repo, dest, { "../escape": "bad" }),
		/越界/,
	);
});
