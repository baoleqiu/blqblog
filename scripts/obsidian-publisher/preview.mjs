import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { assertInside, hash } from "./common.mjs";
import { convertNote } from "./convert.mjs";
import { syncWorkspace, themeFingerprint } from "./workspace.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitForCandidate(
	url,
	fingerprint,
	{ fetchImpl = fetch, attempts = 120, interval = 500, check = () => {} } = {},
) {
	const deadline = Date.now() + 120000;
	for (
		let attempt = 0;
		attempt < attempts && Date.now() < deadline;
		attempt++
	) {
		check();
		try {
			const response = await fetchImpl(url, {
				signal: AbortSignal.timeout(15000),
				cache: "no-store",
			});
			if (
				response.ok &&
				(await response.text()).includes(`data-blq-preview="${fingerprint}"`)
			)
				return;
		} catch {}
		await delay(interval);
	}
	throw Error("预览尚未显示最新版本，请刷新重试。");
}
const bridge = `<script is:inline>
(()=>{
 const version=()=>document.querySelector('[data-blq-preview]')?.dataset.blqPreview;
 const send=()=>{if(parent!==window)parent.postMessage({type:'blq-preview-ready',fingerprint:version()},'*');};
 addEventListener('DOMContentLoaded',send);addEventListener('load',send);
 addEventListener('message',event=>{if(event.source!==parent)return;if(event.data?.type==='blq-preview-request')send();if(event.data?.type==='blq-scroll-to' && Number.isFinite(event.data.position))scrollTo(0,event.data.position);});
 let pending=false;addEventListener('scroll',()=>{if(pending || parent===window)return;pending=true;setTimeout(()=>{pending=false;parent.postMessage({type:'blq-preview-scroll',fingerprint:version(),position:scrollY},'*');},100);});
})();
</script>`;
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
		const themeHash = await themeFingerprint(this.repoRoot);
		candidate.fingerprint = hash(`${candidate.fingerprint}:${themeHash}`);
		const overlay = { ...candidate.files };
		overlay[`src/content/posts/obsidian/${candidate.id}/index.md`] =
			`${candidate.markdown}\n\n<span hidden data-blq-preview="${candidate.fingerprint}"></span>\n`;
		const layoutName = "src/layouts/Layout.astro";
		const layout = await fs.readFile(
			path.join(this.repoRoot, layoutName),
			"utf8",
		);
		if (!layout.includes("</body>"))
			throw Error("主题布局缺少 body，无法确认预览版本。");
		overlay[layoutName] = layout.replace("</body>", `${bridge}\n</body>`);
		const synchronized = await syncWorkspace(this.repoRoot, this.root, overlay);
		if (synchronized.themeHash !== themeHash)
			throw Error("主题正在改变，请重新预览。");
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
		await waitForCandidate(url, candidate.fingerprint, {
			check: () => {
				if (this.failure) throw this.failure;
				if (this.child.exitCode !== null)
					throw Error("博客预览服务意外退出，请检查项目依赖。");
			},
		});
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
		fresh.fingerprint = hash(`${fresh.fingerprint}:${fresh.themeHash}`);
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
		const stat = await fs.lstat(this.root).catch((e) => {
			if (e.code === "ENOENT") return null;
			throw e;
		});
		if (!stat) return;
		if (stat.isSymbolicLink()) throw Error("预览清理目标不能是符号链接。");
		const actual = await fs.realpath(this.root);
		const repository = await fs.realpath(this.repoRoot);
		assertInside(path.join(repository, "cache/obsidian-publisher"), actual);
		await fs.rm(actual, { recursive: true, force: true });
	}
}
