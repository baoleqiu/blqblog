import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export async function buildSite(root, onProgress = () => {}) {
	const require = createRequire(path.join(root, "package.json"));
	const binary = async (pkg, name) => {
		const manifest = require.resolve(`${pkg}/package.json`), data = JSON.parse(await fs.readFile(manifest,"utf8"));
		return path.resolve(path.dirname(manifest), typeof data.bin === "string" ? data.bin : data.bin[name]);
	};
	const steps = [[path.join(root,"scripts/generate-icons.js")], [await binary("tsx","tsx"),"scripts/generate-lqips.ts"], [await binary("astro","astro"),"build"], [await binary("tsx","tsx"),"scripts/subset-fonts.ts"], [await binary("pagefind","pagefind"),"--site","dist"]];
	for (const args of steps) {
		onProgress(`正在构建：${path.basename(args[0])} ${args.slice(1).join(" ")}`);
		await new Promise((resolve,reject)=> {
			const child = spawn(process.execPath,args,{cwd:root,windowsHide:true,env:{...process.env,ASTRO_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
			let tail=""; const log = data=>{tail=(tail+data).slice(-8000);process.stderr.write(data);};
			child.stdout.on("data",log);child.stderr.on("data",log);child.on("error",reject);
			child.on("exit",code=>code===0?resolve():reject(Error(`整站构建失败（${path.basename(args[0])}）。\n${tail.slice(-2000)}`)));
		});
	}
}
