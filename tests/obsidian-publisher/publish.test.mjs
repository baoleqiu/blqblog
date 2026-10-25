import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { temporary } from "./fixtures.mjs";
const exec = promisify(execFile);
let module = {};
try {
	module = await import("../../scripts/obsidian-publisher/publish.mjs");
} catch (e) {
	if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
}
const settings = {
	productionBranch: "main",
	productionConfirmed: true,
	siteUrl: "https://example.test",
};
const candidate = {
	id: "test-article-1234",
	articleUrl: "/posts/obsidian/test-article-1234/",
	contentFingerprint: "first",
	issues: [],
	files: {
		"src/content/posts/obsidian/test-article-1234/index.md": "public-body",
		"public/obsidian-published/test-article-1234/originals/one.png":
			Buffer.from("image"),
	},
};
async function setup(t, options = {}) {
	assert.equal(typeof module.Publisher, "function");
	const dir = await temporary(t, "git-"),
		repo = path.join(dir, "repo"),
		remote = path.join(dir, "remote.git");
	await fs.mkdir(repo);
	await exec("git", ["init", "--bare", remote]);
	await exec("git", ["init", "-b", "main", repo]);
	const git = async (...args) =>
		(await exec("git", args, { cwd: repo })).stdout.trim();
	await git("config", "user.name", "Test");
	await git("config", "user.email", "test@example.test");
	await fs.writeFile(path.join(repo, ".gitignore"), "cache/\n");
	await fs.writeFile(path.join(repo, "tracked.txt"), "base");
	await git("add", "--", ".gitignore", "tracked.txt");
	await git("commit", "-m", "initial");
	await git("remote", "add", "origin", remote);
	await git("push", "-u", "origin", "main");
	const publisher = new module.Publisher(repo, {
		build: async () => {},
		verifyAttempts: 1,
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({ operationId: "old" }),
		}),
		...options,
	});
	return { repo, remote, git, publisher };
}
test("publication commits only owned paths, reports pending deployment and can verify exact version", async (t) => {
	const { repo, git, publisher } = await setup(t);
	await fs.writeFile(path.join(repo, "unrelated.txt"), "private");
	const op = await publisher.publish(candidate, settings);
	assert.equal(op.status, "pushed");
	assert.ok(
		!(await git("show", "--name-only", "--format=", "HEAD")).includes(
			"unrelated.txt",
		),
	);
	publisher.fetchImpl = async () => ({
		ok: true,
		json: async () => ({
			operationId: op.operationId,
			id: candidate.id,
			action: "publish",
		}),
	});
	assert.equal(
		(await publisher.verify(op.operationId, settings)).status,
		"live",
	);
});
test("staged changes, unpushed commits and unconfirmed branches block before writing", async (t) => {
	const { repo, git, publisher } = await setup(t);
	await assert.rejects(
		publisher.publish(candidate, { ...settings, productionConfirmed: false }),
		/生产分支/,
	);
	await fs.writeFile(path.join(repo, "tracked.txt"), "edited");
	await git("add", "tracked.txt");
	await assert.rejects(publisher.publish(candidate, settings), /暂存/);
	await git("commit", "-m", "unrelated");
	await assert.rejects(publisher.publish(candidate, settings), /超前|未推送/);
	await assert.rejects(
		fs.access(path.join(repo, Object.keys(candidate.files)[0])),
	);
});
test("build failure does not write or commit article", async (t) => {
	const { repo, git, publisher } = await setup(t, {
		build: async () => {
			throw Error("build broke");
		},
	});
	const before = await git("rev-parse", "HEAD");
	await assert.rejects(publisher.publish(candidate, settings), /build broke/);
	assert.equal(await git("rev-parse", "HEAD"), before);
	await assert.rejects(
		fs.access(path.join(repo, Object.keys(candidate.files)[0])),
	);
});
test("hand-edited owned output is not overwritten; unpublish and restore retain article identity", async (t) => {
	const { repo, git, publisher } = await setup(t);
	await publisher.publish(candidate, settings);
	const file = path.join(repo, Object.keys(candidate.files)[0]);
	await fs.writeFile(file, "manual");
	await assert.rejects(
		publisher.publish({ ...candidate, contentFingerprint: "second" }, settings),
		/修改|冲突/,
	);
	await fs.writeFile(file, "public-body");
	const down = await publisher.unpublish(candidate.id, settings);
	assert.equal(down.action, "unpublish");
	await assert.rejects(fs.access(file));
	await publisher.publish(candidate, settings);
	assert.equal(await fs.readFile(file, "utf8"), "public-body");
	assert.ok((await git("log", "--oneline")).split("\n").length >= 4);
});
test("push failure retains exact commit and resumes without creating a duplicate", async (t) => {
	const { git, publisher } = await setup(t);
	const push = publisher.git.push.bind(publisher.git);
	publisher.git.push = async () => {
		throw Error("offline");
	};
	const pending = await publisher.publish(candidate, settings);
	assert.equal(pending.status, "committed");
	const before = await git("rev-parse", "HEAD");
	publisher.git.push = push;
	const resumed = await publisher.resume(pending.operationId, settings);
	assert.equal(resumed.status, "pushed");
	assert.equal(await git("rev-parse", "HEAD"), before);
});
