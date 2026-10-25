const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
class PublisherClient {
	constructor(settings, onEvent = () => {}) {
		this.settings = settings;
		this.onEvent = onEvent;
		this.pending = new Map();
		this.serial = 0;
		this.closed = false;
	}
	start() {
		if (this.closed) throw Error("发布器已关闭，请重新打开面板。");
		if (this.child) return;
		if (!this.settings.repoPath)
			throw Error("请先在插件设置填写博客项目路径。");
		this.child = spawn(
			this.settings.nodePath || "node",
			[
				path.join(
					this.settings.repoPath,
					"scripts/obsidian-publisher/worker.mjs",
				),
				"--repo",
				this.settings.repoPath,
			],
			{
				cwd: this.settings.repoPath,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			},
		);
		const child = this.child;
		const fail = () => {
			if (this.child === child) this.child = null;
			for (const request of this.pending.values()) {
				clearTimeout(request.timer);
				request.reject(
					Error("本地发布器退出，请重新预览；已创建的发布操作会保留。"),
				);
			}
			this.pending.clear();
		};
		child.on("error", fail);
		child.on("exit", fail);
		child.stdin.on("error", fail);
		child.stderr.on("data", () => {});
		readline.createInterface({ input: child.stdout }).on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.event) {
				this.onEvent(message.event, message.data);
				return;
			}
			const request = this.pending.get(message.requestId);
			if (!request) return;
			this.pending.delete(message.requestId);
			clearTimeout(request.timer);
			message.ok
				? request.resolve(message.result)
				: request.reject(
						Error(message.error?.message || "本地发布器发生错误。"),
					);
		});
	}
	request(command, payload = {}) {
		try {
			this.start();
		} catch (e) {
			return Promise.reject(e);
		}
		const requestId = String(++this.serial);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => {
					this.pending.delete(requestId);
					reject(
						Error("操作等待超时，请检查本地服务。发布记录可用于继续操作。"),
					);
				},
				30 * 60 * 1000,
			);
			this.pending.set(requestId, { resolve, reject, timer });
			this.child.stdin.write(
				`${JSON.stringify({ requestId, command, payload })}\n`,
			);
		});
	}
	async dispose() {
		if (this.closed) return;
		const child = this.child;
		if (child) {
			try {
				await Promise.race([
					this.request("stop"),
					new Promise((resolve) => setTimeout(resolve, 4000)),
				]);
			} catch {}
			child.stdin.end();
		}
		this.closed = true;
		// Closing stdin lets the worker finish a journaled publication and then stop its own preview.
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(Error("发布面板已关闭。"));
		}
		this.pending.clear();
	}
}
module.exports = { PublisherClient };
