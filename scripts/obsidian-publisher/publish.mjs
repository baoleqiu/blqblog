import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitRepo } from "./git.mjs";
import { assertInside, hash, validateId, writeAtomic } from "./common.mjs";
import { syncWorkspace, themeFingerprint } from "./workspace.mjs";
import { buildSite } from "./build.mjs";

const existsBytes = file => fs.readFile(file).catch(e => { if(e.code === "ENOENT") return null; throw e; });
const digest = bytes => bytes === null ? null : hash(bytes);
const markerPath = id => `public/obsidian-publisher/versions/${id}.json`;
const ownerPath = id => `public/obsidian-publisher/records/${id}.json`;
function ownedPath(id, file) {
	if (!file.startsWith(`src/content/posts/obsidian/${id}/`) && !file.startsWith(`public/obsidian-published/${id}/`) && file !== markerPath(id) && file !== ownerPath(id)) throw Error("输出清单包含不属于该文章的路径。");
	if (file.split("/").includes("..") || file.includes("\\")) throw Error("输出路径越界。");
}
export class Publisher {
	constructor(repoRoot, { build = buildSite, fetchImpl = fetch, onProgress = () => {}, verifyAttempts = 12 } = {}) {
		this.root=repoRoot; this.git=new GitRepo(repoRoot); this.build=build; this.fetchImpl=fetchImpl; this.onProgress=onProgress; this.verifyAttempts=verifyAttempts;
		this.operations=path.join(repoRoot,"cache/obsidian-publisher/operations"); this.busy=false;
	}
	async exclusive(fn) {
		if(this.busy) throw Error("已有发布操作正在进行。"); this.busy=true;
		await fs.mkdir(this.operations,{recursive:true}); const lockPath=path.join(this.operations,"lock.json"); let lock;
		try {
			try { lock=await fs.open(lockPath,"wx"); } catch(e) {
				if(e.code!=="EEXIST") throw e;
				const prior=JSON.parse(await fs.readFile(lockPath,"utf8")); let alive=true;
				try { process.kill(prior.pid,0); } catch(error) { if(error.code==="ESRCH") alive=false; }
				if(alive) throw Error("另一发布器进程正在工作，请稍后重试。");
				await fs.unlink(lockPath); lock=await fs.open(lockPath,"wx");
			}
			await lock.writeFile(JSON.stringify({pid:process.pid})); return await fn();
		} finally { if(lock) { await lock.close(); await fs.unlink(lockPath); } this.busy=false; }
	}
	file(operationId) { validateId(operationId); return path.join(this.operations,`${operationId}.json`); }
	async save(op) { await writeAtomic(this.file(op.operationId),JSON.stringify(op,null,2)); }
	async load(id) { return JSON.parse(await fs.readFile(this.file(id),"utf8")); }
	summary(op) { const {operationId,id,action,status,commit,contentFingerprint,articleUrl,error}=op;return {operationId,id,action,status,commit,contentFingerprint,articleUrl,error}; }
	async owner(id) { const bytes=await existsBytes(path.join(this.root,ownerPath(id))); return bytes?JSON.parse(bytes):null; }
	async checkOwned(id, owner, files) {
		for(const [name,expected] of Object.entries(owner?.files || {})) {
			ownedPath(id,name);
			if(digest(await existsBytes(path.join(this.root,name)))!==expected) throw Error(`受管文件被手工修改或缺失：${name}。请先解决冲突。`);
		}
		for(const name of Object.keys(files)) {
			ownedPath(id,name); assertInside(this.root,path.join(this.root,name));
			if(!owner?.files?.[name] && name!==ownerPath(id) && name!==markerPath(id) && await existsBytes(path.join(this.root,name))) throw Error(`输出位置已有未登记文件：${name}`);
		}
	}
	publish(candidate,settings) { return this.exclusive(()=>this.start(candidate.id,"publish",candidate,settings)); }
	unpublish(id,settings) { return this.exclusive(()=>this.start(id,"unpublish",null,settings)); }
	async start(id,action,candidate,settings) {
		validateId(id); if(candidate?.issues?.some(x=>x.severity==="error")) throw Error("请先解决转换问题。");
		for(const file of await fs.readdir(this.operations)) if(file.endsWith(".json") && file!=="lock.json") {
			const old=await this.load(file.slice(0,-5));
			if(["prepared","committed"].includes(old.status)) throw Error(`有未完成操作，请先继续：${old.operationId}`);
		}
		const owner=await this.owner(id); await this.checkOwned(id,owner,candidate?.files || {});
		const base=await this.git.preflight(settings);
		if(action==="unpublish" && (!owner || owner.action==="unpublish")) throw Error("该文章尚未发布或已经下架。");
		if(action==="publish" && owner?.action==="publish" && owner.contentFingerprint===candidate.contentFingerprint) {
			try { return this.summary(await this.load(owner.operationId)); } catch { throw Error("内容与线上提交一致，无需重复发布。"); }
		}
		const operationId=randomUUID(), files={...(candidate?.files || {})};
		const manifest={id,operationId,action,contentFingerprint:candidate?.contentFingerprint || null,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,hash(bytes)]))};
		files[ownerPath(id)]=JSON.stringify(manifest,null,2); files[markerPath(id)]=JSON.stringify({id,operationId,action});
		const deleted=Object.keys(owner?.files || {}).filter(name=>!Object.hasOwn(files,name));
		this.onProgress("正在检查整站构建……");
		const workspace=path.join(this.root,"cache/obsidian-publisher",`build-${operationId}`);
		const {themeHash}=await syncWorkspace(this.root,workspace,files,deleted);
		if(candidate?.themeHash && candidate.themeHash!==themeHash) throw Error("主题在预览后已改变，请重新预览。");
		await this.build(workspace,this.onProgress);
		if(await themeFingerprint(this.root)!==themeHash || await this.git.preflight(settings)!==base) throw Error("构建期间博客项目发生变化，请重新预览。");
		await this.checkOwned(id,owner,candidate?.files || {});
		const changes={};
		for(const name of [...new Set([...Object.keys(files),...deleted])]) {
			const before=await existsBytes(path.join(this.root,name));
			changes[name]={before:before?.toString("base64") ?? null,after:Object.hasOwn(files,name)?Buffer.from(files[name]).toString("base64"):null};
		}
		const op={operationId,id,action,status:"prepared",base,branch:settings.productionBranch,siteUrl:settings.siteUrl,articleUrl:candidate?.articleUrl || `/posts/obsidian/${id}/`,contentFingerprint:candidate?.contentFingerprint || null,changes};
		await this.save(op); return this.continue(op,settings);
	}
	async continue(op,settings) {
		if(settings.productionBranch!==op.branch || settings.siteUrl!==op.siteUrl) throw Error("设置与原发布操作不一致，请恢复原设置后续传。");
		const upstream=await this.git.connection(settings);
		if(op.status==="prepared") {
			const head=await this.git.head();
			if(head!==op.base) {
				if(await this.git.run("rev-parse","HEAD^")!==op.base || !(await this.git.run("log","-1","--format=%B")).includes(op.operationId)) throw Error("Git 历史发生变化，不能继续原操作。");
				const names=(await this.git.run("diff-tree","--no-commit-id","--name-only","-r","-z","HEAD")).split("\0").filter(Boolean);
				if(names.some(name=>!Object.hasOwn(op.changes,name))) throw Error("提交包含其他改动，无法认领。");
				op.commit=head;op.status="committed";await this.save(op);
			} else {
				if(upstream!==op.base) throw Error("远端已经变化，请先处理原发布操作。");
				const allowed=new Set(Object.keys(op.changes));
				if((await this.git.dirty()).some(name=>!allowed.has(name)) || (await this.git.staged()).some(name=>!allowed.has(name))) throw Error("有其他修改或暂存内容，请先处理。");
				for(const [name,change] of Object.entries(op.changes)) {
					ownedPath(op.id,name); const current=(await existsBytes(path.join(this.root,name)))?.toString("base64") ?? null;
					if(current!==change.before && current!==change.after) throw Error(`文件在操作后被修改：${name}`);
				}
				for(const [name,change] of Object.entries(op.changes)) {
					const target=assertInside(this.root,path.join(this.root,name));
					if(change.after===null) await fs.rm(target,{force:true}); else await writeAtomic(target,Buffer.from(change.after,"base64"));
				}
				this.onProgress("构建通过，正在创建文章提交……");
				op.commit=await this.git.commitPaths([...allowed],`feat(blog): ${op.action} ${op.id} (${op.operationId})`);op.status="committed";await this.save(op);
			}
		}
		if(op.status==="committed") {
			if(await this.git.head()!==op.commit) throw Error("已有其他提交，不能夹带推送，请先处理。");
			if((await this.git.staged()).length || (await this.git.dirty()).length) throw Error("项目有新的修改，请处理后继续推送。");
			if(upstream!==op.base && upstream!==op.commit) throw Error("远端已有其他提交，请手动同步后检查发布记录。");
			try { this.onProgress("正在推送文章提交……"); await this.git.push(); op.status="pushed"; delete op.error; }
			catch { op.error="提交已保留，推送未完成。请检查网络或 Git 登录后点击继续操作。"; }
			await this.save(op);
		}
		if(op.status==="pushed") return this.verify(op.operationId,settings);
		return this.summary(op);
	}
	resume(operationId,settings) { return this.exclusive(async()=>this.continue(await this.load(operationId),settings)); }
	async verify(operationId,settings) {
		const op=await this.load(operationId);
		if(!["pushed","live","unpublished"].includes(op.status)) return this.summary(op);
		if(settings.siteUrl!==op.siteUrl) throw Error("上线验证域名与原操作不一致。");
		this.onProgress("已推送，正在等待网站部署……");
		for(let i=0;i<this.verifyAttempts;i++) {
			try {
				const url=new URL(`/obsidian-publisher/versions/${op.id}.json`,op.siteUrl);url.searchParams.set("v",op.operationId);
				const response=await this.fetchImpl(url,{cache:"no-store",signal:AbortSignal.timeout(8000)});
				const marker=response.ok?await response.json():null;
				if(marker?.operationId===op.operationId && marker.id===op.id && marker.action===op.action) { op.status=op.action==="unpublish"?"unpublished":"live";delete op.error;await this.save(op);return this.summary(op); }
			} catch {}
			if(i+1<this.verifyAttempts) await new Promise(resolve=>setTimeout(resolve,5000));
		}
		op.error="已推送，尚未确认网站上线。稍后可点击检查上线状态。"; await this.save(op);return this.summary(op);
	}
}
