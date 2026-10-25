import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PreviewManager } from "./preview.mjs";

const repoRoot = path.resolve(
	process.argv[process.argv.indexOf("--repo") + 1] || process.cwd(),
);
const send = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
const preview = new PreviewManager(repoRoot, (message) =>
	send({ event: "progress", data: { message } }),
);
let publisher;
let watcher;
let queue = Promise.resolve();
let stopping = false;
try {
	let timer;
	watcher = fs.watch(repoRoot, { recursive: true }, (_event, filename) => {
		const file = String(filename || "").replaceAll("\\", "/");
		if (
			!/^(src\/|public\/|astro\.config|svelte\.config|package\.json|pnpm-lock)/.test(
				file,
			)
		)
			return;
		clearTimeout(timer);
		timer = setTimeout(() => send({ event: "theme-change", data: {} }), 700);
		timer.unref();
	});
} catch {}
async function handle(message) {
	const { command, payload = {} } = message;
	if (command === "stop") {
		stopping = true;
		watcher?.close();
		await preview.stop();
		return { stopped: true };
	}
	if (command === "preview") return preview.preview(payload.snapshot);
	if (command === "inspect") {
		const { GitRepo } = await import("./git.mjs");
		const { Publisher } = await import("./publish.mjs");
		const git = new GitRepo(repoRoot);
		const instance = new Publisher(repoRoot);
		const operations = [];
		const fsp = await import("node:fs/promises");
		for (const file of await fsp.readdir(instance.operations).catch(() => []))
			if (file.endsWith(".json") && file !== "lock.json") {
				const op = await instance.load(file.slice(0, -5));
				const stat = await fsp.stat(instance.file(op.operationId));
				operations.push({ ...instance.summary(op), time: stat.mtimeMs });
			}
		return {
			branch: await git.branch(),
			repoRoot,
			operations: operations.sort((a, b) => a.time - b.time),
		};
	}
	if (["publish", "unpublish", "resume", "verify"].includes(command)) {
		const { Publisher } = await import("./publish.mjs");
		publisher ||= new Publisher(repoRoot, {
			onProgress: (message) => send({ event: "progress", data: { message } }),
		});
		if (command === "publish")
			return publisher.publish(
				await preview.verifiedCandidate(payload.fingerprint, payload.snapshot),
				payload.settings,
			);
		if (command === "unpublish")
			return publisher.unpublish(payload.id, payload.settings);
		return publisher[command](payload.operationId, payload.settings);
	}
	throw Error("无法识别的发布器命令。");
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	queue = queue.then(async () => {
		let message;
		try {
			message = JSON.parse(line);
			if (!message.requestId) throw Error("请求缺少编号。");
			const result = await handle(message);
			send({ requestId: message.requestId, ok: true, result });
		} catch (error) {
			send({
				requestId: message?.requestId || null,
				ok: false,
				error: { message: error.message },
			});
		}
		if (stopping) {
			input.close();
			process.stdin.destroy();
		}
	});
});
input.on("close", () => {
	queue = queue.then(async () => {
		watcher?.close();
		await preview.stop();
	});
});
for (const signal of ["SIGTERM", "SIGINT"])
	process.on(signal, async () => {
		watcher?.close();
		await preview.stop();
		process.exit(0);
	});
