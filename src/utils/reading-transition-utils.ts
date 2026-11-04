import { loadGSAPFlip } from "./gsap-utils";
import { captureReadingPosition } from "./reading-position-utils";

type GSAPContext = ReturnType<typeof import("gsap").gsap.context>;
type ReadingAction = "enter" | "exit" | "toc-open" | "toc-close";

interface ReadingTransition {
	run: (update: () => void, action: ReadingAction) => void;
	cancel: () => void;
	readonly running: boolean;
}

function visibleRect(element: HTMLElement | null): DOMRect | null {
	if (!element?.checkVisibility()) return null;
	const rect = element.getBoundingClientRect();
	return rect.width > 0 &&
		rect.height > 0 &&
		rect.bottom > 0 &&
		rect.top < innerHeight
		? rect
		: null;
}

function sidebarTOC(): HTMLElement | null {
	return (
		document
			.getElementById("sidebar-toc")
			?.closest<HTMLElement>("widget-layout") ?? null
	);
}

function surroundingCards(except: HTMLElement | null): HTMLElement[] {
	const cards = Array.from(
		document.querySelectorAll<HTMLElement>(
			[
				"#top-row",
				"#wallpaper-wrapper",
				"#category-bar-wrapper",
				".footer",
				"#left-sidebar .card-base",
				"#right-sidebar .card-base",
				"#content-wrapper > [data-immersive-surrounding]",
				".floating-controls-container > :not(#immersive-reading-controls)",
				"#spine-model-container",
				"#l2d-widget-container",
			].join(","),
		),
	).filter((element) => element !== except && visibleRect(element));
	return cards.filter(
		(element) =>
			!cards.some((parent) => parent !== element && parent.contains(element)),
	);
}

/** Keep the live article in front while the surrounding cards retreat. */
export function createReadingTransition(): ReadingTransition {
	const root = document.documentElement;
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	let revision = 0;
	let running = false;
	let context: GSAPContext | null = null;
	const originalStyles = new Map<HTMLElement, string | null>();
	const pinnedCards = new Set<HTMLElement>();
	const pinnedParents = new Set<HTMLElement>();

	function rememberStyles(elements: (HTMLElement | null)[]): void {
		for (const element of elements) {
			if (element && !originalStyles.has(element)) {
				originalStyles.set(element, element.getAttribute("style"));
			}
		}
	}

	function finish(version: number): void {
		if (version !== revision) return;
		context?.revert({ suppressEvents: true });
		context = null;
		// Fitting and temporary positioning share targets with the tweens.
		// Restore the exact original styles after animation cleanup.
		for (const [element, style] of originalStyles) {
			if (style === null) element.removeAttribute("style");
			else element.setAttribute("style", style);
		}
		originalStyles.clear();
		for (const element of pinnedCards) delete element.dataset.readingBackdrop;
		for (const element of pinnedParents)
			delete element.dataset.readingBackdropParent;
		pinnedCards.clear();
		pinnedParents.clear();
		running = false;
		root.classList.remove(
			"immersive-reading-transition",
			"immersive-reading-toc-leaving",
		);
	}

	function cancel(): void {
		revision++;
		finish(revision);
	}

	function run(update: () => void, action: ReadingAction): void {
		if (running) return;
		// Finish page entrances before recording a reading position, including
		// the reduced-motion path, so they cannot move the paragraph afterward.
		for (const element of document.querySelectorAll<HTMLElement>(
			".onload-animation",
		)) {
			element.dataset.readingSettled = "";
		}
		if (reducedMotion.matches || document.hidden) {
			update();
			return;
		}
		const version = ++revision;
		running = true;
		root.classList.add("immersive-reading-transition");
		void loadGSAPFlip().then(
			({ gsap, Flip }) => {
				if (version !== revision) return;
				if (reducedMotion.matches || document.hidden) {
					update();
					finish(version);
					return;
				}
				const articleElement = document.getElementById("post-container");
				const toc = document.getElementById("immersive-toc");
				if (!articleElement) {
					finish(version);
					return;
				}
				const article: HTMLElement = articleElement;
				rememberStyles([article, toc, sidebarTOC(), ...surroundingCards(null)]);

				// A viewport reference compensates for the paragraph anchoring performed
				// by the layout update. Flip can then fit the live card to its old bounds.
				function fitVars(element: HTMLElement, rect: DOMRect): gsap.TweenVars {
					const reference = document.createElement("div");
					reference.setAttribute("aria-hidden", "true");
					reference.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;visibility:hidden;pointer-events:none;`;
					document.body.append(reference);
					try {
						return Flip.fit(element, reference, {
							scale: true,
							getVars: true,
						}) as gsap.TweenVars;
					} finally {
						reference.remove();
					}
				}

				context = gsap.context(() => {}, document.body);
				context.add(() => {
					const duration =
						action === "enter" || action === "exit" ? 1.25 : 0.675;
					const timeline = gsap.timeline({ paused: true });

					if (action === "enter" || action === "exit") {
						// All layout work happens before playback, rather than halfway
						// through the movement. Keep the original surrounding DOM alive.
						const beforeArticle = article.getBoundingClientRect();
						const beforeTOC = visibleRect(toc);
						const position = captureReadingPosition(article);
						const anchor = position?.element;
						const anchorTop = position?.top;
						const retreating =
							action === "enter"
								? surroundingCards(null).map((element) => ({
										element,
										rect: element.getBoundingClientRect(),
										display: getComputedStyle(element).display,
									}))
								: [];
						update();
						for (const { element, rect, display } of retreating) {
							element.dataset.readingBackdrop = "";
							pinnedCards.add(element);
							for (const [property, value] of Object.entries({
								position: "fixed",
								left: `${rect.left}px`,
								top: `${rect.top}px`,
								width: `${rect.width}px`,
								height: `${rect.height}px`,
								margin: "0",
								display,
								visibility: "visible",
								"pointer-events": "none",
							}))
								element.style.setProperty(property, value, "important");
							const branch: HTMLElement[] = [];
							for (
								let parent = element.parentElement;
								parent && parent.id !== "main-grid" && parent !== document.body;
								parent = parent.parentElement
							)
								branch.push(parent);
							if (
								branch.some(
									(parent) =>
										pinnedParents.has(parent) ||
										getComputedStyle(parent).display === "none",
								)
							) {
								rememberStyles(branch);
								for (const parent of branch) {
									parent.dataset.readingBackdropParent = "";
									pinnedParents.add(parent);
									parent.style.setProperty("display", "contents", "important");
									parent.style.setProperty("visibility", "hidden", "important");
								}
							}
						}
						// Keep scale rounding local to the visible reading point. Using
						// the top of a 50,000px article amplifies it into visible jitter.
						const articleRect = article.getBoundingClientRect();
						const visibleAnchorY = anchor
							? Math.max(
									24,
									Math.min(
										innerHeight - 24,
										anchor.getBoundingClientRect().top,
									),
								)
							: innerHeight / 2;
						const originY = Math.max(
							0,
							Math.min(articleRect.height, visibleAnchorY - articleRect.top),
						);
						gsap.set(article, { transformOrigin: `0 ${originY}px` });
						const from = fitVars(article, beforeArticle);
						gsap.set(article, from);
						// Width changes reflow the text. Align the visible paragraph as
						// well as the card, avoiding a jump at the animation's first frame.
						if (anchor && anchorTop !== undefined) {
							from.y =
								Number(from.y || 0) +
								anchorTop -
								anchor.getBoundingClientRect().top;
						}
						timeline.fromTo(
							article,
							from,
							{
								x: 0,
								y: 0,
								scaleX: 1,
								scaleY: 1,
								duration,
								ease: "power2.inOut",
								immediateRender: true,
							},
							0,
						);
						if (retreating.length)
							timeline.to(
								retreating.map((card) => card.element),
								{
									opacity: 0,
									y: 24,
									scale: 0.97,
									duration: duration * 0.75,
									ease: "power2.out",
								},
								0,
							);
						if (action === "exit") {
							const returningCards = surroundingCards(null);
							rememberStyles(returningCards);
							timeline.fromTo(
								returningCards,
								{ opacity: 0, y: 24, scale: 0.97 },
								{
									opacity: 1,
									y: 0,
									scale: 1,
									duration: duration * 0.75,
									ease: "power2.out",
									immediateRender: true,
								},
								duration * 0.25,
							);
							if (toc && beforeTOC) {
								root.classList.add("immersive-reading-toc-leaving");
								gsap.set(toc, {
									left: beforeTOC.left,
									top: beforeTOC.top,
									right: "auto",
									bottom: "auto",
									width: beforeTOC.width,
									height: beforeTOC.height,
									transformOrigin: "0 0",
									opacity: 1,
								});
								timeline.to(
									toc,
									{
										y: 24,
										scale: 0.97,
										opacity: 0,
										duration: duration * 0.9,
										ease: "power2.inOut",
									},
									0,
								);
							}
						}
					} else if (toc && action === "toc-open") {
						update();
						timeline.fromTo(
							toc,
							{ opacity: 0, y: 24, scale: 0.97 },
							{
								opacity: 1,
								y: 0,
								scale: 1,
								duration,
								ease: "power2.out",
							},
							0,
						);
					} else if (toc) {
						timeline.to(
							toc,
							{
								opacity: 0,
								y: 24,
								scale: 0.97,
								duration,
								ease: "power2.inOut",
							},
							0,
						);
						timeline.call(update, [], duration);
					}
					timeline.call(() => finish(version), [], duration);
					timeline.play();
				});
			},
			() => {
				// A failed engine download must leave the reading controls usable.
				if (version !== revision) return;
				try {
					update();
				} finally {
					finish(version);
				}
			},
		);
	}

	return {
		run,
		cancel,
		get running() {
			return running;
		},
	};
}
