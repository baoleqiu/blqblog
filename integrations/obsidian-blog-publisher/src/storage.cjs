const { validateState, validateImport } = require("./model.cjs");

class DataStore {
	constructor(adapter, directory) {
		this.adapter = adapter;
		this.directory = directory.replaceAll("\\", "/").replace(/\/$/, "");
		this.file = `${this.directory}/data.json`;
		this.backup = `${this.directory}/data.previous.json`;
		this.queue = Promise.resolve();
		this.recovered = false;
	}
	async load() {
		let primaryError;
		for (const file of [this.file, this.backup]) {
			if (!(await this.adapter.exists(file))) continue;
			try {
				const state = validateState(JSON.parse(await this.adapter.read(file)));
				this.recovered = file === this.backup;
				return state;
			} catch (error) { primaryError ||= error; }
		}
		if (primaryError) throw Error(`发布数据及备份无法读取，未覆盖原文件：${primaryError.message}`);
		return null;
	}
	save(state) {
		const content = JSON.stringify(validateState(state), null, 2);
		const write = async () => {
			if (!(await this.adapter.exists(this.directory))) await this.adapter.mkdir(this.directory);
			if (await this.adapter.exists(this.file)) {
				let previous;
				try { previous = await this.adapter.read(this.file); validateState(JSON.parse(previous)); }
				catch { previous = null; }
				if (previous) await this.adapter.write(this.backup, previous);
			}
			const temporary = `${this.file}.tmp`;
			await this.adapter.write(temporary, content);
			validateState(JSON.parse(await this.adapter.read(temporary)));
			await this.adapter.rename(temporary, this.file);
		};
		this.queue = this.queue.catch(() => {}).then(write);
		return this.queue;
	}
	async export() { await this.queue; return JSON.stringify(await this.load(), null, 2); }
	async import(text) {
		await this.queue;
		if (text.length > 20 * 1024 * 1024) throw Error("导入文件过大，请检查备份格式。");
		let incoming;
		try { incoming = JSON.parse(text); } catch { throw Error("备份不是有效 JSON 格式。"); }
		const merged = validateImport(await this.load(), incoming);
		await this.save(merged);
		return merged;
	}
}
module.exports = { DataStore };
