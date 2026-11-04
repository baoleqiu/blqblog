import { captureReadingPosition as captureArticlePosition } from "./reading-position-utils";
import { createReadingTransition } from "./reading-transition-utils";
import { TOCManager } from "./toc-utils";

let installed = false;

export function setupImmersiveReading(): void {
	if (installed) return;
	const controlsElement = document.getElementById("immersive-reading-controls");
	const toggleElement = document.getElementById("immersive-reading-toggle");
	const tocToggleElement = document.getElementById("immersive-toc-toggle");
	const toc = document.getElementById("immersive-toc");
	const collapse = document.getElementById("immersive-toc-collapse");
	if (!controlsElement || !toggleElement || !tocToggleElement) return;
	const controls: HTMLElement = controlsElement;
	const toggle: HTMLElement = toggleElement;
	const tocToggle: HTMLElement = tocToggleElement;
	installed = true;

	const root = document.documentElement;
	const transition = createReadingTransition();
	const desktop = window.matchMedia("(min-width: 1024px)");
	let active = false;
	let expanded = false;
	let article: HTMLElement | null = null;
	let manager: TOCManager | null = null;
	let restoreFrame = 0;
	let swup = null;

	function setLabel(button: HTMLElement, label: string | undefined): void {
		button.setAttribute("aria-label", label ?? "");
		button.title = label ?? "";
	}

	function updateControls(): void {
		toggle.hidden = !desktop.matches || !article;
		toggle.setAttribute("aria-pressed", String(active));
		setLabel(
			toggle,
			active ? toggle.dataset.exitLabel : toggle.dataset.enterLabel,
		);
		tocToggle.hidden = !active || !toc;
		tocToggle.setAttribute("aria-expanded", String(active && expanded));
		setLabel(
			tocToggle,
			expanded
				? tocToggle.dataset.collapseLabel
				: tocToggle.dataset.expandLabel,
		);
		if (toc) toc.hidden = !active || !expanded;
		if (!active || !expanded) manager?.resetScrollbar();
		root.classList.toggle("immersive-toc-open", active && expanded && !!toc);
	}

	function cleanupTOC(): void {
		manager?.cleanup();
		manager = null;
	}

	function refreshTOC(): void {
		cleanupTOC();
		if (!active || !toc) return;
		manager = new TOCManager({
			contentId: "immersive-toc-content",
			indicatorId: "immersive-active-indicator",
			maxLevel: 3,
			scrollOffset: 24,
		});
		manager.init();
	}

	function captureReadingPosition(): {
		element: HTMLElement;
		top: number;
	} | null {
		return article ? captureArticlePosition(article) : null;
	}

	function retainReadingPosition(
		position: ReturnType<typeof captureReadingPosition>,
	): void {
		if (!position) return;
		window.scrollTo({
			top:
				window.scrollY +
				position.element.getBoundingClientRect().top -
				position.top,
			behavior: "instant",
		});
	}

	function enter(): void {
		if (active || !desktop.matches || !article) return;
		cancelAnimationFrame(restoreFrame);
		root.classList.remove("immersive-reading-restoring");
		const position = captureReadingPosition();
		active = true;
		expanded = false;
		root.dataset.immersiveTocPosition = controls.dataset.tocPosition ?? "right";
		root.classList.add("immersive-reading");
		updateControls();
		refreshTOC();
		// Both directions follow the live paragraph, independently of entry history.
		if (position) retainReadingPosition(position);
		else window.scrollTo({ top: 0, behavior: "instant" });
	}

	function exit(preservePosition = true, restoreFocus = true): void {
		cancelAnimationFrame(restoreFrame);
		root.classList.remove("immersive-reading-restoring");
		cleanupTOC();
		if (!active) return;
		const position = preservePosition ? captureReadingPosition() : null;
		active = false;
		root.classList.add("immersive-reading-restoring");
		root.classList.remove("immersive-reading", "immersive-toc-open");
		delete root.dataset.immersiveTocPosition;
		updateControls();
		retainReadingPosition(position);
		if (restoreFocus && desktop.matches) toggle.focus({ preventScroll: true });
		restoreFrame = requestAnimationFrame(() => {
			root.classList.remove("immersive-reading-restoring");
		});
	}

	function toggleTOC(): void {
		if (!active || !toc) return;
		expanded = !expanded;
		const focusWasInside = toc.contains(document.activeElement);
		updateControls();
		if (!expanded && focusWasInside) tocToggle.focus({ preventScroll: true });
		manager?.updateActiveState();
	}

	function init(): void {
		const nextArticle = document.getElementById("post-container");
		if (article !== nextArticle) {
			transition.cancel();
			exit(false, false);
			article = nextArticle;
			if (article) {
				// Mark only the page's existing sections. Animation libraries may
				// temporarily append measurement elements beside the article later.
				for (const section of document.querySelectorAll<HTMLElement>(
					"#content-wrapper > *",
				)) {
					if (!section.contains(article))
						section.dataset.immersiveSurrounding = "";
				}
			}
			updateControls();
			if (controls.dataset.defaultOn === "true") enter();
		} else {
			updateControls();
		}
	}

	function connectSwup(): void {
		if (!window.swup?.hooks || swup === window.swup) return;
		swup = window.swup;
		window.swup.hooks.on("visit:start", leave);
		window.swup.hooks.on("page:view", init);
	}

	function leave(): void {
		transition.cancel();
		exit(false, false);
	}

	toggle.addEventListener("click", () =>
		transition.run(
			() => (active ? exit() : enter()),
			active ? "exit" : "enter",
		),
	);
	tocToggle.addEventListener("click", () =>
		transition.run(toggleTOC, expanded ? "toc-close" : "toc-open"),
	);
	collapse?.addEventListener("click", () => {
		transition.run(() => {
			toggleTOC();
			tocToggle.focus({ preventScroll: true });
		}, "toc-close");
	});
	document.addEventListener("keydown", (event) => {
		if (
			event.key === "Escape" &&
			(active || transition.running) &&
			!event.defaultPrevented
		) {
			transition.cancel();
			if (active) transition.run(() => exit(), "exit");
		}
	});
	desktop.addEventListener("change", () => {
		if (!desktop.matches) {
			transition.cancel();
			exit(true, false);
		}
		updateControls();
	});
	document.addEventListener("password:decrypted", refreshTOC);
	document.addEventListener("swup:enable", connectSwup);
	document.addEventListener("astro:before-swap", leave);
	document.addEventListener("astro:page-load", init);
	window.addEventListener("pagehide", leave);
	window.addEventListener("pageshow", init);
	connectSwup();
	init();
}
