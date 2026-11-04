import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { openBrowser } from "../helpers/chromium.mjs";

const base = process.env.IMMERSIVE_TEST_URL || "http://127.0.0.1:4321";
const active =
	"document.documentElement.classList.contains('immersive-reading')";
const transitioning =
	"document.documentElement.classList.contains('immersive-reading-transition')";

const output = new URL("../../dist/_astro/", import.meta.url);
const engineChunk = readdirSync(output).find(
	(name) =>
		name.endsWith(".js") &&
		readFileSync(new URL(name, output), "utf8").includes("gsapVersions"),
);
assert.ok(
	engineChunk,
	"build the GSAP-enabled site before running browser tests",
);
const engineUrl = new URL(
	`_astro/${engineChunk}`,
	base.endsWith("/") ? base : `${base}/`,
).href;
const engineLoaded = `performance.getEntriesByType('resource').some(entry => entry.name === ${JSON.stringify(engineUrl)})`;

test("immersive reading lifts the article and directory above retreating cards", {
	timeout: 60000,
}, async (t) => {
	const browser = await openBrowser();
	t.after(() => browser.close());
	const { evaluate, until } = browser;
	await browser.resize(1440);
	await browser.navigate(base);
	await until("window.swup && document.querySelector('a[href*=\"/posts/\"]')");
	assert.equal(await evaluate(engineLoaded), false, "home must not load GSAP");
	await evaluate("document.querySelector('a[href*=\"/posts/\"]').click()");
	await until(
		"document.getElementById('post-container') && !window.swup.navigating && document.getElementById('immersive-reading-toggle').checkVisibility()",
	);
	assert.equal(
		await evaluate(engineLoaded),
		false,
		"article entry must not load GSAP before interaction",
	);

	await t.test(
		"the article keeps its existing size and position through the layout handoff",
		async () => {
			const frames = await evaluate(`new Promise(resolve => {
			const article = document.getElementById('post-container');
			const started = performance.now();
			let motionStarted = null;
			const frames = [];
			function sample() {
				const rect = article.getBoundingClientRect();
				if (motionStarted === null && article.style.transform) motionStarted = performance.now();
				frames.push({t:performance.now()-started,motionTime:motionStarted===null ? 0:performance.now()-motionStarted,x:rect.x,y:rect.y,width:rect.width,height:rect.height});
			}
			sample();
			document.getElementById('immersive-reading-toggle').click();
			function tick() {
				sample();
				if (document.documentElement.classList.contains('immersive-reading-transition')) requestAnimationFrame(tick);
				else resolve(frames);
			}
			requestAnimationFrame(tick);
		})`);
			try {
				const earlyMotion = frames.find(
					(frame) => frame.motionTime >= 250 && frame.motionTime < 400,
				);
				assert.ok(
					earlyMotion && Math.abs(earlyMotion.x - frames[0].x) > 1,
					"the article must start its main movement promptly, without a separate lift-and-wait stage",
				);
				const minimumWidth = Math.min(frames[0].width, frames.at(-1).width);
				const collapsed = frames.find(
					(frame) => frame.width < minimumWidth - 2,
				);
				assert.equal(
					collapsed,
					undefined,
					`article unexpectedly shrank: ${JSON.stringify(collapsed)}`,
				);
				for (let index = 1; index < frames.length; index++) {
					const before = frames[index - 1];
					const after = frames[index];
					assert.ok(
						Math.abs(after.x - before.x) < 150 &&
							Math.abs(after.y - before.y) < 150,
						`article jumped between frames: ${JSON.stringify({ before, after })}`,
					);
				}
			} finally {
				await evaluate(
					"document.getElementById('immersive-reading-toggle').click()",
				);
				await until(`!(${active}) && !(${transitioning})`);
			}
		},
	);

	async function clickAndFinish(id, expectedState) {
		const animatedId =
			id === "immersive-reading-toggle" ? "post-container" : "immersive-toc";
		const stationaryArticle =
			id === "immersive-reading-toggle"
				? null
				: await evaluate(
						"document.getElementById('post-container').getBoundingClientRect().toJSON()",
					);
		await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
		if (await evaluate("window.__readingParagraph instanceof HTMLElement")) {
			await evaluate(`(() => {
				window.__paragraphMotionFrames = [window.__readingParagraphTop];
				function sample() {
					window.__paragraphMotionFrames.push(window.__readingParagraph.getBoundingClientRect().top);
					if (document.documentElement.classList.contains('immersive-reading-transition')) requestAnimationFrame(sample);
				}
				sample();
			})()`);
		}
		if (stationaryArticle) {
			await evaluate(`(() => {
				window.__directoryArticleFrames = [];
				function sample() {
					window.__directoryArticleFrames.push(document.getElementById('post-container').getBoundingClientRect().toJSON());
					if (document.documentElement.classList.contains('immersive-reading-transition')) requestAnimationFrame(sample);
				}
				sample();
			})()`);
		}
		assert.equal(
			await evaluate(transitioning),
			true,
			"an animated transition should start",
		);
		await until(`${engineLoaded} || !(${transitioning})`);
		assert.equal(
			await evaluate(engineLoaded),
			true,
			"the interaction should load the GSAP library",
		);
		await evaluate(
			`import(${JSON.stringify(engineUrl)}).then(module => { window.__readingTestGSAP = module.gsap; })`,
		);
		await until(
			`window.__readingTestGSAP.getTweensOf(document.getElementById('${animatedId}')).length > 0 || !(${transitioning})`,
		);
		assert.ok(
			await evaluate(
				`window.__readingTestGSAP.getTweensOf(document.getElementById('${animatedId}')).length > 0`,
			),
			"animate the live target, rather than fading the whole document",
		);
		assert.equal(
			await evaluate("getComputedStyle(document.body).opacity"),
			"1",
		);
		assert.equal(
			await evaluate(
				"getComputedStyle(document.getElementById('post-container')).opacity",
			),
			"1",
		);
		assert.equal(
			await evaluate(
				`window.__readingTestGSAP.getTweensOf(document.getElementById('${animatedId}'))[0].parent.duration()`,
			),
			id === "immersive-reading-toggle" ? 1.25 : 0.675,
		);
		if (stationaryArticle) {
			assert.equal(
				await evaluate(
					"window.__readingTestGSAP.getTweensOf(document.getElementById('post-container')).length",
				),
				0,
				"directory controls must not create unnecessary article transforms",
			);
		}
		await until(`!(${transitioning})`);
		if (await evaluate("Array.isArray(window.__paragraphMotionFrames)")) {
			const positions = await evaluate("window.__paragraphMotionFrames");
			assert.ok(
				positions
					.slice(1)
					.every(
						(position, index) => Math.abs(position - positions[index]) < 4,
					),
				"the current paragraph must not jump when the card starts moving or the layout changes",
			);
			await evaluate("delete window.__paragraphMotionFrames");
		}
		if (stationaryArticle) {
			const frames = await evaluate("window.__directoryArticleFrames");
			assert.ok(frames.length > 1);
			assert.ok(
				frames.every(
					(frame) =>
						Math.abs(frame.x - stationaryArticle.x) < 1 &&
						Math.abs(frame.y - stationaryArticle.y) < 1 &&
						Math.abs(frame.width - stationaryArticle.width) < 1,
				),
				"opening or closing the directory must never move or resize the article",
			);
			await evaluate("delete window.__directoryArticleFrames");
		}
		assert.equal(await evaluate(expectedState), true);
		if (id === "immersive-reading-toggle" && (await evaluate(active))) {
			assert.equal(
				await evaluate("document.getElementById('immersive-toc').hidden"),
				true,
				"every entry must start with the directory closed, even after it was previously opened",
			);
		}
		if (await evaluate(active)) {
			assert.equal(
				await evaluate(
					"getComputedStyle(document.getElementById('wallpaper-wrapper')).visibility",
				),
				"hidden",
				"the wallpaper must remain hidden after animation cleanup",
			);
		}
		assert.equal(
			await evaluate(
				"window.__readingTestGSAP.getTweensOf([document.getElementById('post-container'), document.getElementById('immersive-toc')]).length",
			),
			0,
			"finished tweens must be cleaned up",
		);
		assert.equal(
			await evaluate("document.body.style.opacity"),
			"",
			"GSAP must restore the original inline style",
		);
		assert.equal(
			await evaluate(
				"document.getElementById('post-container').style.transform",
			),
			"",
		);
		assert.equal(
			await evaluate(
				"document.documentElement.classList.contains('immersive-reading-toc-leaving')",
			),
			false,
		);
		assert.equal(
			await evaluate(
				"document.querySelectorAll('[data-reading-backdrop], [data-reading-backdrop-parent]').length",
			),
			0,
			"temporary surrounding card styles must be cleaned up",
		);
	}

	await t.test(
		"entry and exit take 1.25 seconds; directory controls take 675ms",
		async () => {
			await clickAndFinish("immersive-reading-toggle", active);
			assert.equal(
				await evaluate("document.getElementById('immersive-toc').hidden"),
				true,
			);
			assert.equal(
				await evaluate("document.documentElement.dataset.immersiveTocPosition"),
				"right",
			);
			await clickAndFinish(
				"immersive-toc-toggle",
				"!document.getElementById('immersive-toc').hidden",
			);
			await clickAndFinish(
				"immersive-toc-collapse",
				"document.getElementById('immersive-toc').hidden",
			);
			await clickAndFinish(
				"immersive-toc-toggle",
				"!document.getElementById('immersive-toc').hidden",
			);
			await clickAndFinish("immersive-reading-toggle", `!(${active})`);
			assert.equal(
				await evaluate("document.activeElement.id"),
				"immersive-reading-toggle",
			);
		},
	);
	await t.test(
		"surrounding cards really fade and sink while the article stays opaque",
		async () => {
			await evaluate(`(async () => {
			document.getElementById('immersive-reading-toggle').click();
			await new Promise(requestAnimationFrame);
			window.__readingTimeline = window.__readingTestGSAP.getTweensOf(document.getElementById('post-container'))[0].parent;
			window.__readingTimeline.pause(0.08, false);
		})()`);
			const state = await evaluate(`(() => {
			const card = document.querySelector('#left-sidebar .card-base');
			const style = getComputedStyle(card);
			const transform = new DOMMatrixReadOnly(style.transform);
			return { opacity: Number(style.opacity), y: transform.m42, scale: transform.a,
				articleOpacity: getComputedStyle(document.getElementById('post-container')).opacity };
		})()`);
			assert.ok(state.opacity > 0 && state.opacity < 1, JSON.stringify(state));
			assert.ok(state.y > 0 && state.scale < 1, JSON.stringify(state));
			assert.equal(state.articleOpacity, "1");
			await evaluate(
				"window.__readingTimeline.play(); delete window.__readingTimeline",
			);
			await until(`${active} && !(${transitioning})`);
			await clickAndFinish("immersive-reading-toggle", `!(${active})`);
		},
	);
	await t.test("reduced motion changes layouts immediately", async () => {
		await browser.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await evaluate(
			"document.getElementById('immersive-reading-toggle').click()",
		);
		assert.equal(await evaluate(active), true);
		assert.equal(await evaluate(transitioning), false);
		await evaluate(
			"document.getElementById('immersive-reading-toggle').click()",
		);
		assert.equal(await evaluate(active), false);
		await browser.send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
		});
	});
	await t.test(
		"the card animation also works without native view transitions",
		async () => {
			await evaluate(
				"window.__readingNativeTransition = document.startViewTransition; document.startViewTransition = undefined; document.getElementById('immersive-reading-toggle').click()",
			);
			assert.equal(await evaluate(transitioning), true);
			await until(
				"window.__readingTestGSAP.getTweensOf(document.getElementById('post-container')).length > 0",
			);
			await until(`${active} && !(${transitioning})`);
			assert.equal(
				await evaluate("getComputedStyle(document.body).opacity"),
				"1",
			);
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click()",
			);
			await until(`!(${active}) && !(${transitioning})`);
			await evaluate(
				"document.startViewTransition = window.__readingNativeTransition; delete window.__readingNativeTransition",
			);
		},
	);
	await t.test(
		"animated exit follows the paragraph reached during immersive reading",
		async () => {
			async function rememberParagraph(fraction) {
				await evaluate(`(() => {
				const article = document.getElementById('post-container');
				const paragraphs = Array.from(article.querySelectorAll('.custom-md p')).filter(p => p.getBoundingClientRect().height > 12);
				const target = paragraphs[Math.floor(paragraphs.length * ${fraction})];
				window.scrollTo({top:scrollY+target.getBoundingClientRect().top-80,behavior:'instant'});
				window.__readingParagraph = Array.from(article.querySelectorAll('h1,h2,h3,h4,p,pre,figure')).find(p => p.getBoundingClientRect().bottom > 24 && p.getBoundingClientRect().top < innerHeight);
				window.__readingParagraphTop = window.__readingParagraph.getBoundingClientRect().top;
			})()`);
			}
			await rememberParagraph(0.2);
			await clickAndFinish("immersive-reading-toggle", active);
			assert.ok(
				await evaluate(
					"Math.abs(window.__readingParagraph.getBoundingClientRect().top - window.__readingParagraphTop) < 2",
				),
				"animated entry must preserve the current paragraph",
			);
			await rememberParagraph(0.65);
			await clickAndFinish("immersive-reading-toggle", `!(${active})`);
			assert.ok(
				await evaluate(
					"Math.abs(window.__readingParagraph.getBoundingClientRect().top - window.__readingParagraphTop) < 2",
				),
				"animated exit must retain the newly reached paragraph",
			);
			await evaluate(
				"delete window.__readingParagraph; delete window.__readingParagraphTop",
			);
		},
	);
	await t.test(
		"Escape cancels a pending entry without a late mode change",
		async () => {
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click(); document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))",
			);
			await until(`!(${active}) && !(${transitioning})`);
			await evaluate("new Promise(resolve => setTimeout(resolve, 350))");
			assert.equal(await evaluate(active), false);
		},
	);
	await t.test(
		"navigation cancels the fade and never enters on the home page",
		async () => {
			await evaluate(
				`document.getElementById('immersive-reading-toggle').click(); window.swup.navigate(${JSON.stringify(`${base}/`)})`,
			);
			await until(
				"!document.getElementById('post-container') && !window.swup.navigating",
			);
			await evaluate("new Promise(resolve => setTimeout(resolve, 350))");
			assert.equal(await evaluate(active), false);
			assert.equal(await evaluate(transitioning), false);
			assert.equal(
				await evaluate("getComputedStyle(document.body).opacity"),
				"1",
			);
		},
	);
});
