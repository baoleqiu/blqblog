interface ReadingPosition {
	element: HTMLElement;
	top: number;
}

/** Prefer a visible block start over the offscreen start of a long paragraph. */
export function captureReadingPosition(
	article: HTMLElement,
): ReadingPosition | null {
	let partial: ReadingPosition | null = null;
	for (const element of article.querySelectorAll<HTMLElement>(
		"h1,h2,h3,h4,p,pre,figure",
	)) {
		const rect = element.getBoundingClientRect();
		if (rect.height <= 0 || rect.bottom <= 24 || rect.top >= innerHeight)
			continue;
		const position = { element, top: rect.top };
		if (rect.top >= 24) return position;
		partial ??= position;
	}
	return partial;
}
