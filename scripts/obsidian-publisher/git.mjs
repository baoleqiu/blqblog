import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export class GitRepo {
	constructor(root, binary = "git") { this.root = root; this.binary = binary; }
	async run(...args) { return (await execute(this.binary, args, { cwd: this.root, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim(); }
	head() { return this.run("rev-parse", "HEAD"); }
	branch() { return this.run("symbolic-ref", "--short", "HEAD"); }
	async connection(settings) {
		if (!settings.productionConfirmed || !settings.productionBranch || await this.branch() !== settings.productionBranch) throw Error("请在设置中确认 Vercel 生产分支，并切换到该分支后发布。");
		this.remote = await this.run("config", `branch.${settings.productionBranch}.remote`);
		this.ref = await this.run("config", `branch.${settings.productionBranch}.merge`);
		if (!this.remote || this.remote === "." || !this.ref.startsWith("refs/heads/")) throw Error("生产分支没有有效的远端上游。");
		await this.run("fetch", "--", this.remote);
		return this.run("rev-parse", "@{upstream}");
	}
	async dirty() { return (await this.run("diff", "--name-only", "-z", "HEAD")).split("\0").filter(Boolean); }
	async staged() { return (await this.run("diff", "--cached", "--name-only", "-z")).split("\0").filter(Boolean); }
	async preflight(settings) {
		if ((await this.staged()).length) throw Error("Git 暂存区已有改动，请先处理，发布器不会夹带提交。");
		const upstream = await this.connection(settings), head = await this.head();
		if (upstream !== head) throw Error("本地分支存在未推送提交、落后或分歧，请先同步 Git。");
		if ((await this.dirty()).length) throw Error("博客项目存在未提交的修改，请先处理后发布。");
		return head;
	}
	async commitPaths(paths, message) { await this.run("add", "--", ...paths); await this.run("commit", "-m", message); return this.head(); }
	async push() { await this.run("push", "--", this.remote, `HEAD:${this.ref}`); }
}
