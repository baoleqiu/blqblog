const { PluginSettingTab, Setting, Notice, Modal } = require("obsidian");
class TextModal extends Modal {
	constructor(app, title, value, onSave, readonly = false) {
		super(app);
		this.title = title;
		this.value = value;
		this.onSave = onSave;
		this.readonly = readonly;
	}
	onOpen() {
		this.contentEl.createEl("h2", { text: this.title });
		const area = this.contentEl.createEl("textarea", { cls: "blq-backup" });
		area.value = this.value;
		area.readOnly = this.readonly;
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText(this.readonly ? "复制备份" : "导入")
				.setCta()
				.onClick(async () => {
					try {
						if (this.readonly) {
							await navigator.clipboard.writeText(area.value);
							new Notice("已复制 JSON 备份，请保存到安全位置。");
						} else {
							await this.onSave(area.value);
							this.close();
						}
					} catch (e) {
						new Notice(e.message, 10000);
					}
				}),
		);
	}
}
class PublisherSettings extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const el = this.containerEl;
		el.empty();
		el.createEl("h2", { text: "BLQ 博客发布" });
		el.createEl("p", {
			text: "文章信息保存在插件数据中。原笔记不添加属性。预览使用这台电脑上的博客主题。",
		});
		const settings = this.plugin.state.settings;
		for (const [key, title, placeholder] of [
			["repoPath", "博客项目目录", "E:\\blqblog"],
			["nodePath", "Node 程序路径", "E:\\nodejs\\node.exe"],
			["siteUrl", "正式网站域名", "https://blqblog.cn"],
			["productionBranch", "Vercel 生产分支", "master"],
		]) {
			new Setting(el).setName(title).addText((t) =>
				t
					.setPlaceholder(placeholder)
					.setValue(settings[key] || "")
					.onChange(async (value) => {
						settings[key] = value.trim();
						if (key === "productionBranch")
							settings.productionConfirmed = false;
						await this.plugin.save();
						await this.plugin.closeClient();
						this.plugin.invalidate();
					}),
			);
		}
		new Setting(el)
			.setName("已核实生产分支")
			.setDesc(
				"请以 Vercel 项目的 Production Branch 设置为准；当前 Git 分支也必须与其一致。预览不需要开启。首次实际发布请先审阅文章。",
			)
			.addToggle((t) =>
				t.setValue(settings.productionConfirmed).onChange(async (value) => {
					settings.productionConfirmed = value;
					await this.plugin.save();
				}),
			);
		new Setting(el).setName("检查本地 Git").addButton((b) =>
			b.setButtonText("检查").onClick(() =>
				this.plugin.safe(async () => {
					const result = await this.plugin.getClient().request("inspect");
					new Notice(`当前分支：${result.branch}`, 10000);
				}),
			),
		);
		new Setting(el)
			.setName("导出发布数据")
			.setDesc(
				"备份标题、分类、标签、文章编号与发布记录；不包含笔记正文和图片。",
			)
			.addButton((b) =>
				b
					.setButtonText("导出 JSON")
					.onClick(() =>
						this.plugin.safe(async () =>
							new TextModal(
								this.app,
								"发布数据备份",
								await this.plugin.store.export(),
								null,
								true,
							).open(),
						),
					),
			);
		new Setting(el)
			.setName("导入发布数据")
			.setDesc("不同路径的备份需先明确迁移路径；冲突记录不会自动覆盖当前数据。")
			.addButton((b) =>
				b.setButtonText("导入 JSON").onClick(() =>
					new TextModal(this.app, "粘贴发布数据 JSON", "", async (text) => {
						const result = await this.plugin.store.import(text);
						this.plugin.state = result;
						this.plugin.view()?.render();
						new Notice("发布数据已导入。");
					}).open(),
				),
			);
		new Setting(el)
			.setName("迁移备份到当前电脑")
			.setDesc(
				"仅用于明确迁移：将备份的库和博客路径改为当前设置后检查冲突，再导入。笔记的库内路径仍须保持一致。",
			)
			.addButton((b) =>
				b.setButtonText("迁移导入").onClick(() =>
					new TextModal(
						this.app,
						"迁移备份到当前库与博客目录",
						"",
						async (text) => {
							const data = JSON.parse(text);
							data.settings = {
								...data.settings,
								vaultRoot: this.app.vault.adapter.getBasePath(),
								repoPath: settings.repoPath,
							};
							this.plugin.state = await this.plugin.store.import(
								JSON.stringify(data),
							);
							this.plugin.view()?.render();
							new Notice("发布记录已迁移，请重新预览核对。");
						},
					).open(),
				),
			);
	}
}
module.exports = { PublisherSettings };
