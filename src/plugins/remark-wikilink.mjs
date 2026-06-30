/**
 * Remark plugin to convert Obsidian-style [[wikilinks]] to Markdown links.
 * Supports [[page]] and [[page|alias]] syntax.
 */
export function remarkWikilink() {
	return (tree) => {
		visit(tree, "text", (node, index, parent) => {
			if (!parent || index === undefined) return;

			const matches = [...node.value.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)];
			if (matches.length === 0) return;

			const newNodes = [];
			let lastIndex = 0;

			for (const match of matches) {
				// Text before the wikilink
				const before = node.value.slice(lastIndex, match.index);
				if (before) {
					newNodes.push({ type: "text", value: before });
				}

				const target = match[1].trim();
				const alias = match[2]?.trim() || target;
				// Slugify: lowercase, strip special chars, normalize spaces to hyphens
				const slug = target
					.toLowerCase()
					.replace(/[《》「」『』【】]/g, "") // remove Chinese brackets
					.replace(/[^\w一-鿿-]/g, "-") // replace non-word/non-Chinese chars with -
					.replace(/-+/g, "-") // collapse multiple hyphens
					.replace(/^-|-$/g, ""); // trim leading/trailing hyphens

				newNodes.push({
					type: "link",
					url: `/posts/${slug}/`,
					children: [{ type: "text", value: alias }],
				});

				lastIndex = match.index + match[0].length;
			}

			// Remaining text after last wikilink
			const after = node.value.slice(lastIndex);
			if (after) {
				newNodes.push({ type: "text", value: after });
			}

			// Replace original text node with new nodes
			parent.children.splice(index, 1, ...newNodes);
		});
	};
}

/** Minimal AST visitor */
function visit(node, type, fn) {
	if (!node) return;
	if (node.type === type) {
		fn(node, undefined, undefined);
	}
	if (node.children) {
		node.children.forEach((child, i) => {
			visitWithParent(node, child, i, type, fn);
		});
	}
}

function visitWithParent(parent, child, index, type, fn) {
	if (!child) return;
	if (child.type === type) {
		fn(child, index, parent);
	}
	if (child.children) {
		child.children.forEach((grandchild, i) => {
			visitWithParent(child, grandchild, i, type, fn);
		});
	}
}
