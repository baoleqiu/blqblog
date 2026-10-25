import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { convertNote } from "./convert.mjs";
import { syncWorkspace, themeFingerprint } from "./workspace.mjs";
import { hash } from "./common.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}
export class PreviewManager {
	constructor(repoRoot, onProgress = () => {}) {
		this.repoRoot = repoRoot;
		this.onProgress = onProgress;
		this.root = path.join(
			repoRoot,
			"cache/obsidian-publisher",
			`preview-${process.pid}-${randomUUID()}`,
		);
		this.child = null;
		this.candidate = null;
	}
	async preview(snapshot) {
		this.candidate = null;
		const candidate = await convertNote(snapshot);
		const { themeHash } = await syncWorkspace(
			this.repoRoot,
			this.root,
			candidate.files,
		);
		candidate.fingerprint = hash(
			`${candidate.contentFingerprint}:${themeHash}`,
		);
		candidate.themeHash = themeHash;
		if (this.child && this.themeHash !== themeHash) await this.stopServer();
		this.themeHash = themeHash;
		if (!this.child) {
			this.port = await freePort();
			const require = createRequire(path.join(this.repoRoot, "package.json"));
			const astro = path.join(
				path.dirname(require.resolve("astro/package.json")),
				"bin/astro.mjs",
			);
			this.onProgress("正在启动真实博客主题预览……");
			this.child = spawn(
				process.execPath,
				[astro, "dev", "--host", "127.0.0.1", "--port", String(this.port)],
				{
					cwd: this.root,
					windowsHide: true,
					env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			this.child.stdout.on("data", (data) => process.stderr.write(data));
			this.child.stderr.on("data", (data) => process.stderr.write(data));
			this.child.on("error", (e) => {
				this.failure = e;
			});
		}
		const url = `http://127.0.0.1:${this.port}${candidate.articleUrl}`;
		let ready = false;
		for (let attempt = 0; attempt < 120; attempt++) {
			if (this.failure) throw this.failure;
			if (this.child.exitCode !== null)
				throw Error("博客预览服务意外退出，请检查项目依赖。");
			try {
				const response = await fetch(url, {
					signal: AbortSignal.timeout(5000),
				});
				if (response.ok) {
					await response.text();
					ready = true;
					break;
				}
			} catch {}
			await delay(500);
		}
		if (!ready) throw Error("预览页面未能加载，请检查博客项目后重试。");
		this.candidate = candidate;
		this.snapshot = snapshot;
		return {
			url: `${url}?publisher=${candidate.fingerprint}`,
			...this.summary(candidate),
		};
	}
	summary(candidate) {
		const {
			id,
			articleUrl,
			fingerprint,
			contentFingerprint,
			issues,
			metadata,
		} = candidate;
		return {
			id,
			articleUrl,
			fingerprint,
			contentFingerprint,
			issues,
			metadata,
		};
	}
	async verifiedCandidate(fingerprint, snapshot) {
		if (!this.candidate || this.candidate.fingerprint !== fingerprint)
			throw Error("预览已过期，请刷新后再发布。");
		const fresh = await convertNote(snapshot);
		fresh.themeHash = await themeFingerprint(this.repoRoot);
		fresh.fingerprint = hash(`${fresh.contentFingerprint}:${fresh.themeHash}`);
		if (fresh.fingerprint !== fingerprint)
			throw Error("正文、附件或主题已改变，请重新预览。");
		if (fresh.issues.some((x) => x.severity === "error"))
			throw Error("请先解决面板中列出的转换问题。");
		return fresh;
	}
	async stopServer() {
		const child = this.child;
		this.child = null;
		this.failure = null;
		if (child && child.exitCode === null) {
			child.kill();
			await Promise.race([
				new Promise((resolve) => child.once("exit", resolve)),
				delay(3000),
			]);
		}
	}
	async stop() {
		await this.stopServer();
	}
}
