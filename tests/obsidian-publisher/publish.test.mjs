import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { temporary } from "./fixtures.mjs";

const exec = promisify(execFile);

import { GitRepo } from "../../scripts/obsidian-publisher/git.mjs";

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
		"public/obsidian-published/test-article-1234/originals/video.mp4":
			Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 255, 0, 128]),
	},
};
async function setup(t, options = {}) {
	assert.equal(typeof module.Publisher, "function");
	const dir = await temporary(t, "git-");
	const repo = path.join(dir, "repo");
	const remote = path.join(dir, "remote.git");
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
test("a concurrent unrelated staged file is excluded and preserved by article commit", async (t) => {
	const { repo, git } = await setup(t);
	const engine = new GitRepo(repo);
	const base = await engine.head();
	await fs.writeFile(path.join(repo, "article.txt"), "owned");
	await fs.writeFile(path.join(repo, "concurrent.txt"), "private");
	await git("add", "concurrent.txt");
	const commit = await engine.commitPaths(
		["article.txt"],
		"feat: article",
		base,
	);
	assert.equal(
		await git("show", "--name-only", "--format=", commit),
		"article.txt",
	);
	assert.equal(await git("diff", "--cached", "--name-only"), "concurrent.txt");
});
test("push uses recorded commit even when HEAD advances concurrently", async (t) => {
	const { repo, git, remote } = await setup(t);
	const engine = new GitRepo(repo);
	await engine.connection(settings);
	await fs.writeFile(path.join(repo, "article.txt"), "owned");
	const commit = await engine.commitPaths(["article.txt"], "feat: article");
	await fs.writeFile(path.join(repo, "concurrent.txt"), "private");
	await git("add", "concurrent.txt");
	await git("commit", "-m", "unrelated concurrent commit");
	await engine.push(commit);
	const remoteHead = (
		await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])
	).stdout.trim();
	assert.equal(remoteHead, commit);
});
test("untracked render inputs block publication while unrelated untracked files are allowed", async (t) => {
	const { repo, publisher } = await setup(t);
	await fs.mkdir(path.join(repo, "src"));
	await fs.writeFile(path.join(repo, "src/untracked.css"), "body{color:red}");
	await assert.rejects(
		publisher.publish(candidate, settings),
		/未跟踪|构建输入/,
	);
});
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
	const videoKey = Object.keys(candidate.files).find((name) =>
		name.endsWith(".mp4"),
	);
	const videoFile = path.join(repo, videoKey);
	assert.deepEqual(await fs.readFile(videoFile), candidate.files[videoKey]);
	await fs.writeFile(file, "manual");
	await assert.rejects(
		publisher.publish({ ...candidate, contentFingerprint: "second" }, settings),
		/修改|冲突/,
	);
	await fs.writeFile(file, "public-body");
	const down = await publisher.unpublish(candidate.id, settings);
	assert.equal(down.action, "unpublish");
	await assert.rejects(fs.access(file));
	await assert.rejects(fs.access(videoFile));
	await publisher.publish(candidate, settings);
	assert.deepEqual(await fs.readFile(videoFile), candidate.files[videoKey]);
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
test("a fresh publisher resumes a process interruption after files were prepared", async (t) => {
	const { repo, publisher } = await setup(t);
	publisher.git.commitPaths = async () => {
		throw Error("simulated process interruption");
	};
	await assert.rejects(publisher.publish(candidate, settings), /simulated/);
	const ids = (await fs.readdir(publisher.operations)).filter((name) =>
		name.endsWith(".json"),
	);
	assert.equal(ids.length, 1);
	const restart = new module.Publisher(repo, {
		build: async () => {},
		verifyAttempts: 1,
		fetchImpl: async () => ({ ok: false }),
	});
	const result = await restart.resume(ids[0].slice(0, -5), settings);
	assert.equal(result.status, "pushed");
	assert.equal(
		await fs.readFile(path.join(repo, Object.keys(candidate.files)[0]), "utf8"),
		"public-body",
	);
});
test("a remote commit appearing after local sync blocks a new publication", async (t) => {
	const { repo, remote, publisher } = await setup(t);
	const other = path.join(path.dirname(repo), "other");
	await exec("git", ["clone", "-b", "main", remote, other]);
	const run = async (...args) => exec("git", args, { cwd: other });
	await run("config", "user.name", "Other");
	await run("config", "user.email", "other@example.test");
	await fs.writeFile(path.join(other, "tracked.txt"), "remote update");
	await run("add", "tracked.txt");
	await run("commit", "-m", "remote update");
	await run("push");
	await assert.rejects(publisher.publish(candidate, settings), /落后|分歧/);
	await assert.rejects(
		fs.access(path.join(repo, Object.keys(candidate.files)[0])),
	);
});
