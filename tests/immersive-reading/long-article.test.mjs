import assert from "node:assert/strict";
import test from "node:test";
import { openBrowser } from "../helpers/chromium.mjs";

const base = process.env.IMMERSIVE_TEST_URL || "http://127.0.0.1:4321";
const articleUrl = new URL(
	"/posts/obsidian/bcebd91b-54e6-41d4-8857-d094f6350ae1/",
	base,
).href;

test("long article endings stay stable through entry and exit", {
	timeout: 60000,
}, async (t) => {
	const browser = await openBrowser();
	t.after(() => browser.close());
	await browser.resize(1440);
	await browser.navigate(articleUrl);
	await browser.until(
		"window.swup && document.getElementById('immersive-reading-toggle').checkVisibility()",
	);
	for (const selector of ["p", "h1"]) {
		await t.test(
			`the last ${selector} stays at the reading position`,
			async () => {
				await browser.evaluate(
					"if(document.documentElement.classList.contains('immersive-reading'))document.getElementById('immersive-reading-toggle').click()",
				);
				await browser.until(
					"!document.documentElement.classList.contains('immersive-reading') && !document.documentElement.classList.contains('immersive-reading-transition')",
				);
				await browser.evaluate(`(() => {
				window.__endingParagraph = Array.from(document.querySelectorAll('#post-container .custom-md ${selector}')).at(-1);
				window.scrollTo({top:scrollY+window.__endingParagraph.getBoundingClientRect().top-32,behavior:'instant'});
			})()`);
				await browser.evaluate(
					"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
				);
				for (const action of ["enter", "exit"]) {
					const positions = await browser.evaluate(`new Promise(resolve => {
					const samples=[window.__endingParagraph.getBoundingClientRect().top];
					let tail=0;
					document.getElementById('immersive-reading-toggle').click();
					function sample(){
						samples.push(window.__endingParagraph.getBoundingClientRect().top);
						if(document.documentElement.classList.contains('immersive-reading-transition') || tail++<2)requestAnimationFrame(sample);
						else resolve(samples);
					}
					requestAnimationFrame(sample);
				})`);
					const largestStep = Math.max(
						...positions
							.slice(1)
							.map((value, index) => Math.abs(value - positions[index])),
					);
					assert.ok(
						largestStep < 1.25,
						`${action} jittered by ${largestStep}px at the end of the long article`,
					);
					assert.ok(
						Math.abs(positions.at(-1) - positions[0]) < 2,
						`${action} moved the ending away from the reading position`,
					);
				}
			},
		);
	}
});
