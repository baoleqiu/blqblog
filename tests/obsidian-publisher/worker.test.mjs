import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
test("worker correlates JSONL errors and exits on stop without leaking body", async () => {
	const script = path.resolve("scripts/obsidian-publisher/worker.mjs"); await fs.access(script);
	const child = spawn(process.execPath,[script,"--repo",process.cwd()],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
	let stdout="", stderr=""; child.stdout.on("data", x=>stdout+=x); child.stderr.on("data",x=>stderr+=x);
	const ended = new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(Error(stderr)));});
	child.stdin.write(JSON.stringify({requestId:"a",command:"unknown",payload:{markdown:"PRIVATE-BODY"}})+"\n");
	child.stdin.write(JSON.stringify({requestId:"b",command:"stop"})+"\n");
	await ended;
	const lines=stdout.trim().split("\n").map(x=>JSON.parse(x));
	assert.equal(lines.find(x=>x.requestId==="a").ok,false); assert.equal(lines.find(x=>x.requestId==="b").ok,true);
	assert.ok(!stdout.includes("PRIVATE-BODY"));
});
