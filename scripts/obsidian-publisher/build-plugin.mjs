import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const source = path.join(root, "integrations/obsidian-blog-publisher"),
	output = path.join(root, "cache/obsidian-publisher-plugin");
await fs.mkdir(output, { recursive: true });
await build({
	entryPoints: [path.join(source, "src/main.cjs")],
	outfile: path.join(output, "main.js"),
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2022",
	external: ["obsidian", "electron"],
	logLevel: "warning",
});
for (const file of ["manifest.json", "styles.css"])
	await fs.copyFile(path.join(source, file), path.join(output, file));
console.log(`插件安装包：${output}`);
