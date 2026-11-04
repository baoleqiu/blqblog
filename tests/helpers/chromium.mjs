import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Use an existing browser; CHROME_PATH also supports CI and non-Windows hosts.
export async function openBrowser() {
	const cache = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
	const cached = existsSync(cache)
		? readdirSync(cache)
				.filter((name) => name.startsWith("chromium_headless_shell-"))
				.sort()
				.reverse()
		: [];
	const executable =
		process.env.CHROME_PATH ||
		cached
			.map((name) =>
				path.join(
					cache,
					name,
					"chrome-headless-shell-win64",
					"chrome-headless-shell.exe",
				),
			)
			.find(existsSync);
	if (!executable)
		throw new Error("Set CHROME_PATH to an installed Chromium executable.");
	const child = spawn(
		executable,
		[
			"--headless",
			"--no-sandbox",
			"--disable-gpu",
			"--remote-debugging-port=0",
			`--user-data-dir=${mkdtempSync(path.join(tmpdir(), "firefly-reading-"))}`,
			"about:blank",
		],
		{ windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
	);
	const endpoint = await new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(
			() => reject(new Error(output || "Chromium did not start")),
			15000,
		);
		child.once("error", reject);
		child.stderr.on("data", (data) => {
			output += data;
			const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
			if (match) {
				clearTimeout(timeout);
				resolve(match[1]);
			}
		});
	});
	const origin = new URL(endpoint).origin.replace("ws:", "http:");
	const targets = await (await fetch(`${origin}/json/list`)).json();
	const socket = new WebSocket(
		targets.find((target) => target.type === "page").webSocketDebuggerUrl,
	);
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = reject;
	});
	const pending = new Map();
	const errors = [];
	let nextId = 0;
	socket.onmessage = ({ data }) => {
		const message = JSON.parse(data);
		if (message.method === "Runtime.exceptionThrown") {
			errors.push(
				message.params.exceptionDetails.exception?.description ||
					message.params.exceptionDetails.text,
			);
		}
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		clearTimeout(request.timeout);
		if (message.error) request.reject(new Error(JSON.stringify(message.error)));
		else request.resolve(message.result);
	};
	function send(method, params = {}) {
		return new Promise((resolve, reject) => {
			const id = ++nextId;
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Timeout: ${method}`));
			}, 20000);
			pending.set(id, { resolve, reject, timeout });
			socket.send(JSON.stringify({ id, method, params }));
		});
	}
	async function evaluate(expression) {
		const result = await send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails)
			throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	}
	async function until(expression) {
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			if (await evaluate(`Boolean(${expression})`)) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const state = await evaluate(
			"JSON.stringify({url: location.href, post: !!document.getElementById('post-container'), toggle: document.getElementById('immersive-reading-toggle')?.outerHTML, navigating: window.swup?.navigating, classes: document.documentElement.className})",
		);
		throw new Error(
			`Condition not met: ${expression}\n${state}\n${errors.join("\n")}`,
		);
	}
	await send("Runtime.enable");
	return {
		send,
		evaluate,
		until,
		errors,
		async navigate(url) {
			await send("Page.navigate", { url });
			await until(
				`location.href === ${JSON.stringify(new URL(url).href)} && document.readyState !== 'loading'`,
			);
		},
		async resize(width, height = 960) {
			await send("Emulation.setDeviceMetricsOverride", {
				width,
				height,
				deviceScaleFactor: 1,
				mobile: false,
			});
		},
		async close() {
			socket.close();
			child.kill();
		},
	};
}
