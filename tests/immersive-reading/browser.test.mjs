import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { openBrowser } from "../helpers/chromium.mjs";

const base = process.env.IMMERSIVE_TEST_URL || "http://127.0.0.1:4321";
const articleAlpha = `(() => {
	const context = document.createElement('canvas').getContext('2d');
	context.fillStyle = getComputedStyle(document.getElementById('post-container')).backgroundColor;
	context.fillRect(0, 0, 1, 1);
	return context.getImageData(0, 0, 1, 1).data[3];
})()`;

test("immersive reading in a real browser", { timeout: 120000 }, async (t) => {
	const browser = await openBrowser();
	t.after(() => browser.close());
	const { evaluate, until } = browser;
	await browser.resize(1440);
	await browser.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
	await browser.navigate(base);
	await until("document.querySelector('a[href*=\"/posts/\"]') && window.swup");
	const postUrl = await evaluate(
		"document.querySelector('a[href*=\"/posts/\"]').href",
	);
	const localPostUrls = await evaluate(
		"Array.from(new Set(Array.from(document.querySelectorAll('a[href*=\"/posts/\"]')).filter(a => a.origin === location.origin).map(a => a.href)))",
	);
	await t.test(
		"home has no visible entry; Swup article navigation enables entry",
		async () => {
			assert.equal(
				await evaluate(
					"!!document.querySelector('#immersive-reading-toggle')?.checkVisibility()",
				),
				false,
			);
			await evaluate(
				"window.__readingTestMarker = true; document.querySelector('a[href*=\"/posts/\"]').click()",
			);
			await until("!!document.getElementById('post-container')");
			assert.equal(
				await evaluate("window.__readingTestMarker"),
				true,
				"navigation should use Swup",
			);
			assert.equal(
				await evaluate(
					"getComputedStyle(document.getElementById('immersive-reading-toggle')).color",
				),
				await evaluate(
					"getComputedStyle(document.getElementById('back-to-home-btn')).color",
				),
			);
			assert.equal(
				await evaluate(
					"!!document.querySelector('#immersive-reading-toggle')?.checkVisibility()",
				),
				true,
			);
		},
	);
	await t.test(
		"entry hides distractions and keeps an opaque reading surface",
		async () => {
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click()",
			);
			assert.equal(
				await evaluate(
					"document.documentElement.classList.contains('immersive-reading')",
				),
				true,
			);
			await until(
				"Math.abs(document.getElementById('post-container').getBoundingClientRect().top + window.scrollY - 24) < 2",
			);
			assert.equal(
				await evaluate(
					"document.querySelector('.immersive-exit-icon svg').checkVisibility()",
				),
				true,
			);
			for (const selector of [
				"#top-row",
				"#wallpaper-wrapper",
				"#category-bar-wrapper",
				".footer",
				"#left-sidebar-wrapper",
				"#right-sidebar-dynamic",
				"#floating-toc-wrapper",
			]) {
				assert.equal(
					await evaluate(
						`!!document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`,
					),
					false,
					selector,
				);
			}
			assert.equal(await evaluate(articleAlpha), 255);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-toc').checkVisibility()",
				),
				false,
			);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-toc-toggle').getAttribute('aria-expanded')",
				),
				"false",
			);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-reading-toggle').getAttribute('aria-pressed')",
				),
				"true",
			);
		},
	);
	await t.test(
		"both TOC controls keep the article centered and stationary",
		async () => {
			await evaluate("document.getElementById('immersive-toc-toggle').click()");
			const expandedRect = await evaluate(
				"document.getElementById('post-container').getBoundingClientRect().toJSON()",
			);
			assert.ok(
				Math.abs(
					expandedRect.left +
						expandedRect.width / 2 -
						(await evaluate("document.documentElement.clientWidth / 2")),
				) < 2,
				"the article must be centered in the viewport, independently of the TOC",
			);
			await evaluate(
				"document.getElementById('immersive-toc-collapse').click()",
			);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-toc').checkVisibility()",
				),
				false,
			);
			const collapsedRect = await evaluate(
				"document.getElementById('post-container').getBoundingClientRect().toJSON()",
			);
			assert.ok(Math.abs(collapsedRect.left - expandedRect.left) < 1);
			assert.ok(Math.abs(collapsedRect.width - expandedRect.width) < 1);
			assert.equal(
				await evaluate("document.activeElement.id"),
				"immersive-toc-toggle",
			);
			await evaluate("document.getElementById('immersive-toc-toggle').click()");
			const reopenedRect = await evaluate(
				"document.getElementById('post-container').getBoundingClientRect().toJSON()",
			);
			assert.ok(Math.abs(reopenedRect.left - expandedRect.left) < 1);
			assert.ok(Math.abs(reopenedRect.width - expandedRect.width) < 1);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-toc').checkVisibility()",
				),
				true,
			);
			const linkCount = await evaluate(
				"document.querySelectorAll('#immersive-toc-content a').length",
			);
			if (linkCount) {
				await evaluate(
					"document.querySelector('#immersive-toc-content a:last-of-type').click()",
				);
				await until("window.scrollY > 0");
			}
		},
	);
	await t.test(
		"entry and Escape preserve the paragraph currently being read",
		async () => {
			await browser.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Escape",
				code: "Escape",
			});
			await until(
				"!document.documentElement.classList.contains('immersive-reading')",
			);
			async function rememberParagraph(fraction) {
				await evaluate(`(() => {
				const paragraphs = Array.from(document.querySelectorAll('#post-container .custom-md p')).filter(p => p.getBoundingClientRect().height > 12);
				const target = paragraphs[Math.floor(paragraphs.length * ${fraction})];
				window.scrollTo({top: scrollY + target.getBoundingClientRect().top - 80, behavior:'instant'});
				window.__currentReadingParagraph = Array.from(document.querySelectorAll('#post-container h1, #post-container h2, #post-container h3, #post-container h4, #post-container p, #post-container pre, #post-container figure')).find(p => p.getBoundingClientRect().bottom > 24 && p.getBoundingClientRect().top < innerHeight);
				window.__currentReadingOffset = window.__currentReadingParagraph.getBoundingClientRect().top;
			})()`);
			}
			await rememberParagraph(0.25);
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click()",
			);
			assert.ok(
				await evaluate(
					"Math.abs(window.__currentReadingParagraph.getBoundingClientRect().top - window.__currentReadingOffset) < 2",
				),
				"entry must retain the current paragraph on screen",
			);
			await rememberParagraph(0.65);
			await browser.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Escape",
				code: "Escape",
			});
			assert.ok(
				await evaluate(
					"Math.abs(window.__currentReadingParagraph.getBoundingClientRect().top - window.__currentReadingOffset) < 2",
				),
				"exit must retain the newly reached paragraph, rather than returning to the entry paragraph",
			);
			assert.equal(
				await evaluate("document.activeElement.id"),
				"immersive-reading-toggle",
			);
			await evaluate(
				"delete window.__currentReadingParagraph; delete window.__currentReadingOffset",
			);
		},
	);
	await t.test(
		"all wallpaper modes and both themes keep chrome hidden and article opaque",
		async () => {
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click()",
			);
			for (const dark of [false, true]) {
				for (const mode of ["none", "banner", "fullscreen", "overlay"]) {
					await evaluate(
						`document.documentElement.classList.toggle('dark', ${dark}); document.documentElement.dataset.wallpaperMode = '${mode}'; document.body.classList.toggle('wallpaper-transparent', '${mode}' === 'overlay')`,
					);
					assert.equal(
						await evaluate(
							"document.getElementById('top-row').checkVisibility()",
						),
						false,
					);
					assert.equal(
						await evaluate(
							"document.getElementById('wallpaper-wrapper')?.checkVisibility() ?? false",
						),
						false,
					);
					assert.equal(
						await evaluate(articleAlpha),
						255,
						`${mode}, dark=${dark}`,
					);
					assert.ok(
						(await evaluate(
							"document.getElementById('post-container').getBoundingClientRect().width",
						)) >= 600,
					);
				}
			}
			if (process.env.IMMERSIVE_SCREENSHOT) {
				await evaluate(
					"document.documentElement.classList.remove('dark'); window.scrollTo({top: 0, behavior: 'instant'})",
				);
				const { data } = await browser.send("Page.captureScreenshot", {
					format: "png",
				});
				writeFileSync(
					process.env.IMMERSIVE_SCREENSHOT,
					Buffer.from(data, "base64"),
				);
			}
		},
	);
	await t.test(
		"right-hand TOC floats independently beside the centered article",
		async () => {
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click(); document.getElementById('immersive-reading-controls').dataset.tocPosition = 'right'; document.getElementById('immersive-reading-toggle').click(); document.getElementById('immersive-toc-toggle').click()",
			);
			await browser.resize(1920);
			assert.ok(
				await evaluate(
					"document.getElementById('post-container').getBoundingClientRect().right < document.getElementById('immersive-toc').getBoundingClientRect().left",
				),
			);
			await browser.resize(1440);
			assert.ok(
				await evaluate(`(() => {
			const article = document.getElementById('post-container').getBoundingClientRect();
			const toc = document.getElementById('immersive-toc').getBoundingClientRect();
			return Math.abs(article.x + article.width/2 - document.documentElement.clientWidth/2) < 2 &&
				toc.left > document.documentElement.clientWidth/2 && toc.right < document.documentElement.clientWidth;
		})()`),
			);
			await evaluate("document.getElementById('immersive-toc-toggle').click()");
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-toc').checkVisibility()",
				),
				false,
			);
			await evaluate(
				"document.getElementById('immersive-toc-toggle').click(); document.getElementById('immersive-reading-toggle').click(); document.getElementById('immersive-reading-controls').dataset.tocPosition = 'left'; document.getElementById('immersive-reading-toggle').click(); document.getElementById('immersive-toc-toggle').click()",
			);
		},
	);
	await t.test(
		"empty content and content revealed after decryption rebuild the TOC",
		async () => {
			await evaluate(
				"window.__readingContent = document.querySelector('#post-container .custom-md').innerHTML; document.querySelector('#post-container .custom-md').replaceChildren(); document.dispatchEvent(new Event('password:decrypted'))",
			);
			assert.equal(
				await evaluate(
					"document.querySelectorAll('#immersive-toc-content a').length",
				),
				0,
			);
			assert.ok(
				await evaluate(
					"document.getElementById('immersive-toc-content').textContent.trim().length > 0",
				),
			);
			await evaluate(
				"var lateHeading = document.createElement('h2'); lateHeading.id = 'late-unlocked-heading'; lateHeading.textContent = '解锁后的章节'; document.querySelector('#post-container .custom-md').append(lateHeading); document.dispatchEvent(new Event('password:decrypted'))",
			);
			assert.equal(
				await evaluate(
					"document.querySelector('#immersive-toc-content a').dataset.headingId",
				),
				"late-unlocked-heading",
			);
			await evaluate(
				"document.querySelector('#post-container .custom-md').innerHTML = window.__readingContent; delete window.__readingContent; document.dispatchEvent(new Event('password:decrypted'))",
			);
		},
	);
	await t.test(
		"1024px is supported; 1023px exits and hides the entry",
		async () => {
			await browser.resize(1024);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-reading-toggle').checkVisibility()",
				),
				true,
			);
			assert.ok(
				await evaluate(
					"document.documentElement.scrollWidth <= window.innerWidth",
				),
			);
			await browser.resize(1023);
			await until(
				"!document.documentElement.classList.contains('immersive-reading')",
			);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-reading-toggle').checkVisibility()",
				),
				false,
			);
			await browser.resize(1440);
			await until(
				"document.getElementById('immersive-reading-toggle').checkVisibility()",
			);
		},
	);
	await t.test(
		"leaving an article clears state and cached navigation reinitializes it",
		async () => {
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click()",
			);
			await evaluate(`window.swup.navigate(${JSON.stringify(`${base}/`)})`);
			await until(
				"!document.getElementById('post-container') && !window.swup.navigating",
			);
			assert.equal(
				await evaluate(
					"document.documentElement.classList.contains('immersive-reading')",
				),
				false,
			);
			assert.equal(
				await evaluate("document.getElementById('top-row').checkVisibility()"),
				true,
			);
			assert.equal(
				await evaluate(
					"document.getElementById('immersive-reading-toggle').checkVisibility()",
				),
				false,
			);
			await evaluate(`window.swup.navigate(${JSON.stringify(postUrl)})`);
			await until(
				"document.getElementById('post-container') && document.getElementById('immersive-reading-toggle').checkVisibility()",
			);
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click()",
			);
			assert.equal(
				await evaluate(
					"document.documentElement.classList.contains('immersive-reading')",
				),
				true,
			);
		},
	);
	await t.test(
		"default-on applies between articles and browser Back",
		async () => {
			const other = await evaluate(
				"Array.from(document.querySelectorAll('a[href*=\"/posts/\"]')).find(a => a.origin === location.origin && a.pathname !== location.pathname && !a.hash)?.href",
			);
			assert.ok(other, "the article should link to another published article");
			await evaluate(
				"document.getElementById('immersive-reading-controls').dataset.defaultOn = 'true'",
			);
			await evaluate(`window.swup.navigate(${JSON.stringify(other)})`);
			await until(
				`location.href === ${JSON.stringify(other)} && !window.swup.navigating`,
			);
			assert.equal(
				await evaluate(
					"document.documentElement.classList.contains('immersive-reading')",
				),
				true,
			);
			await evaluate("history.back()");
			await until(
				`location.href === ${JSON.stringify(postUrl)} && !window.swup.navigating`,
			);
			assert.equal(
				await evaluate(
					"document.documentElement.classList.contains('immersive-reading')",
				),
				true,
			);
			await evaluate(
				"document.getElementById('immersive-reading-controls').dataset.defaultOn = 'false'",
			);
		},
	);
	await t.test(
		"a directly loaded article builds a working heading navigation",
		async () => {
			let foundHeadings = false;
			for (const candidate of localPostUrls) {
				await browser.navigate(candidate);
				await until(
					"document.getElementById('post-container') && document.getElementById('immersive-reading-toggle').checkVisibility()",
				);
				if (
					await evaluate(
						"document.querySelector('#post-container .custom-md h1[id], #post-container .custom-md h2[id]') !== null",
					)
				) {
					foundHeadings = true;
					break;
				}
			}
			assert.ok(
				foundHeadings,
				"at least one published article must have headings",
			);
			await evaluate(
				"document.getElementById('immersive-reading-toggle').click(); document.getElementById('immersive-toc-toggle').click()",
			);
			await until(
				"Math.abs(document.getElementById('post-container').getBoundingClientRect().top + window.scrollY - 24) < 2",
			);
			assert.ok(
				await evaluate(
					"(() => { const toc = document.getElementById('immersive-toc'); const r = toc.getBoundingClientRect(); return document.elementFromPoint(r.left + 24, r.top + 32)?.closest('#immersive-toc') === toc; })()",
				),
			);
			await evaluate(
				"document.querySelector('#immersive-toc-content a:last-of-type').click()",
			);
			await until(
				"(() => {const id = document.querySelector('#immersive-toc-content a:last-of-type').dataset.headingId; const rect = document.getElementById(id).getBoundingClientRect(); return rect.top >= -1 && rect.top < innerHeight && window.scrollY > 0})()",
			);
		},
	);
});
