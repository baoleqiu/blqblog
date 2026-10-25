import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sourceFiles } from "./workspace.mjs";

const execute = promisify(execFile);
export class GitRepo {
	constructor(root, binary = "git") {
		this.root = root;
		this.binary = binary;
	}
	async run(...args) {
		return this.runEnv({}, ...args);
	}
	async runEnv(environment, ...args) {
		return (
			await execute(this.binary, args, {
				cwd: this.root,
				windowsHide: true,
				maxBuffer: 8 * 1024 * 1024,
				timeout: 120000,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...environment },
			})
		).stdout.trim();
	}
	head() {
		return this.run("rev-parse", "HEAD");
	}
	branch() {
		return this.run("symbolic-ref", "--short", "HEAD");
	}
	async connection(settings) {
		if (
			!settings.productionConfirmed ||
			!settings.productionBranch ||
			(await this.branch()) !== settings.productionBranch
		)
			throw Error("请在设置中确认 Vercel 生产分支，并切换到该分支后发布。");
		this.remote = await this.run(
			"config",
			`branch.${settings.productionBranch}.remote`,
		);
		this.ref = await this.run(
			"config",
			`branch.${settings.productionBranch}.merge`,
		);
		if (
			!this.remote ||
			this.remote === "." ||
			!this.ref.startsWith("refs/heads/")
		)
			throw Error("生产分支没有有效的远端上游。");
		await this.run("fetch", "--", this.remote);
		return this.run("rev-parse", "@{upstream}");
	}
	async dirty() {
		return (await this.run("diff", "--name-only", "-z", "HEAD"))
			.split("\0")
			.filter(Boolean);
	}
	async staged() {
		return (await this.run("diff", "--cached", "--name-only", "-z"))
			.split("\0")
			.filter(Boolean);
	}
	async preflight(settings) {
		if ((await this.staged()).length)
			throw Error("Git 暂存区已有改动，请先处理，发布器不会夹带提交。");
		const upstream = await this.connection(settings);
		const head = await this.head();
		if (upstream !== head)
			throw Error("本地分支存在未推送提交、落后或分歧，请先同步 Git。");
		if ((await this.dirty()).length)
			throw Error("博客项目存在未提交的修改，请先处理后发布。");
		const tracked = new Set(
			(await this.run("ls-files", "--cached", "-z")).split("\0"),
		);
		const untracked = (await sourceFiles(this.root)).filter(
			(name) => !tracked.has(name),
		);
		if (untracked.length)
			throw Error(
				`存在未跟踪的构建输入，请先提交或移走：${untracked.slice(0, 5).join("、")}`,
			);
		return head;
	}
	async commitPaths(paths, message, expectedBase, changes) {
		const base = expectedBase || (await this.head());
		const branch = await this.branch();
		const cache = path.join(this.root, "cache/obsidian-publisher");
		await fs.mkdir(cache, { recursive: true });
		const temporary = await fs.mkdtemp(path.join(cache, "git-index-"));
		if (!temporary.startsWith(cache + path.sep)) throw Error("临时目录越界。");
		const environment = { GIT_INDEX_FILE: path.join(temporary, "index") };
		try {
			await this.runEnv(environment, "read-tree", base);
			for (const [index, name] of paths.entries()) {
				const bytes = changes
					? changes[name].after === null
						? null
						: Buffer.from(changes[name].after, "base64")
					: await fs.readFile(path.join(this.root, name)).catch((e) => {
							if (e.code === "ENOENT") return null;
							throw e;
						});
				if (bytes === null)
					await this.runEnv(
						environment,
						"update-index",
						"--force-remove",
						"--",
						name,
					);
				else {
					const blobFile = path.join(temporary, `blob-${index}`);
					await fs.writeFile(blobFile, bytes);
					const blob = await this.run(
						"hash-object",
						"-w",
						"--no-filters",
						"--",
						blobFile,
					);
					await this.runEnv(
						environment,
						"update-index",
						"--add",
						"--cacheinfo",
						`100644,${blob},${name}`,
					);
				}
			}
			const tree = await this.runEnv(environment, "write-tree");
			const commit = await this.run(
				"commit-tree",
				tree,
				"-p",
				base,
				"-m",
				message,
			);
			const actual = (
				await this.run(
					"diff-tree",
					"--no-commit-id",
					"--name-only",
					"-r",
					"-z",
					commit,
				)
			)
				.split("\0")
				.filter(Boolean);
			if (actual.some((name) => !paths.includes(name)))
				throw Error("提交包含额外文件，已阻止更新分支。");
			// Compare-and-swap avoids replacing a commit made by another Git client.
			await this.run("update-ref", `refs/heads/${branch}`, commit, base);
			// Refresh only our index entries; unrelated staged changes remain staged.
			await this.run("reset", "--quiet", commit, "--", ...paths);
			return commit;
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}
	async push(commit) {
		if (!/^[a-f0-9]{40,64}$/.test(commit || ""))
			throw Error("缺少发布提交编号。");
		await this.run("push", "--", this.remote, `${commit}:${this.ref}`);
	}
}
