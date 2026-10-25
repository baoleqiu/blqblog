class PreviewController {
	constructor() {
		this.id = null;
		this.generation = 0;
		this.result = null;
		this.displayedFingerprint = null;
		this.publishing = false;
		this.missing = false;
	}
	bind(id) {
		this.id = id;
		this.invalidate();
	}
	invalidate() {
		this.generation++;
		this.result = null;
		this.displayedFingerprint = null;
	}
	begin() {
		this.invalidate();
		return this.generation;
	}
	accept(generation, result) {
		if (generation !== this.generation) return false;
		this.result = result;
		return true;
	}
	displayed(fingerprint) {
		if (this.result?.fingerprint === fingerprint)
			this.displayedFingerprint = fingerprint;
	}
	ready() {
		return Boolean(
			this.id &&
				!this.publishing &&
				!this.missing &&
				this.result &&
				this.result.fingerprint === this.displayedFingerprint &&
				!this.result.issues.some((x) => x.severity === "error"),
		);
	}
}
module.exports = { PreviewController };
