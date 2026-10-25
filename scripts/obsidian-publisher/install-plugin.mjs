import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertInside } from "./common.mjs";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const vaultArg = process.argv[2];
if (!vaultArg)
	throw Error(
		"用法：node scripts/obsidian-publisher/install-plugin.mjs <笔记库路径>",
	);
const vault = await fs.realpath(vaultArg);
const config = path.join(vault, ".obsidian");
await fs.access(config);
const destination = assertInside(
	vault,
	path.join(config, "plugins/blqblog-publisher"),
);
await fs.mkdir(destination, { recursive: true });
assertInside(vault, await fs.realpath(destination));
const source = path.join(root, "cache/obsidian-publisher-plugin");
const backup = path.join(destination, `backup-${Date.now()}`);
for (const file of ["manifest.json", "main.js", "styles.css"]) {
	await fs.access(path.join(source, file));
	try {
		await fs.access(path.join(destination, file));
		await fs.mkdir(backup, { recursive: true });
		await fs.copyFile(path.join(destination, file), path.join(backup, file));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await fs.copyFile(path.join(source, file), path.join(destination, file));
}
console.log(`已安装：${destination}。已有 data.json 保持不变。`);
