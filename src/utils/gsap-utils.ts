let modulePromise: Promise<typeof import("gsap")> | null = null;

type GSAPFlip = {
	gsap: typeof import("gsap").gsap;
	Flip: typeof import("gsap/Flip").Flip;
};
let flipPromise: Promise<GSAPFlip> | null = null;

/** Share one on-demand animation engine; a failed download can be retried. */
export function loadGSAP(): Promise<typeof import("gsap")> {
	modulePromise ??= import("gsap").catch((error) => {
		modulePromise = null;
		throw error;
	});
	return modulePromise;
}

/** Load and register layout animation only when reading controls are used. */
export function loadGSAPFlip(): Promise<GSAPFlip> {
	flipPromise ??= Promise.all([loadGSAP(), import("gsap/Flip")])
		.then(([{ gsap }, { Flip }]) => {
			gsap.registerPlugin(Flip);
			return { gsap, Flip };
		})
		.catch((error) => {
			flipPromise = null;
			throw error;
		});
	return flipPromise;
}
