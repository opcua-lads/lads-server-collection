// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Chromatogram model of the simulated HPLC.

After an injection the sample reaches the detector after the dead time t0 = dead volume / flow (10 s at 1 ml/min with
the default dead volume of 166.7 µl). Its components then elute within the elution window (50 s at 1 ml/min; both
times scale with 1 / flow). Each component is a peak

    signal(t, λ) = h · L(t) · G(λ)
    L(t) = 1 / (1 + ((t − tR) / w)²)          Lorentz profile, maximum 1 at the retention time tR
    G(λ) = exp(−(λ − λc)² / (2 σ²))           absorption band of the component, maximum at λc

w is the half width at half maximum (FWHM = 2 w) and sets the peak width; the area of L is π · w, so the peak area at
wavelength λ is π · h · w · G(λ). Every injection gets 3 … 8 peaks with random height, width, retention time and
absorption band; the detector channels (DAD1A … D at their wavelengths, the spectrum DAD1I) show the sum of all peaks.
*/

export interface Peak {
    retentionTime: number   // [s] after the injection
    height: number          // [mAU] at the maximum of the absorption band
    halfWidth: number       // w [s]: half width at half maximum
    wavelength: number      // λc [nm]: maximum of the absorption band
    bandWidth: number       // σ [nm]
}

export interface ChromatogramOptions {
    flow: number            // [ml/min] at the injection
    deadVolume: number      // [µl]
    elutionWindow: number   // [s] at 1 ml/min
    minPeaks?: number
    maxPeaks?: number
}

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

export class Chromatogram {
    readonly injected = Date.now()
    readonly peaks: Peak[]
    readonly deadTime: number     // [s]
    readonly end: number          // [s] after the injection: last peak + tail

    constructor(readonly sampleId: string, options: ChromatogramOptions) {
        const flow = Math.max(options.flow, 1e-3)
        this.deadTime = options.deadVolume / 1000 / flow * 60
        const window = options.elutionWindow / flow
        const n = Math.round(rnd(options.minPeaks ?? 3, (options.maxPeaks ?? 8) + 0.49))
        this.peaks = Array.from({ length: n }, () => ({
            retentionTime: this.deadTime + rnd(0.05, 0.95) * window,
            height: rnd(20, 800),
            halfWidth: rnd(0.4, 2.5) / Math.sqrt(flow),
            wavelength: rnd(220, 500),
            bandWidth: rnd(15, 70),
        })).sort((a, b) => a.retentionTime - b.retentionTime)
        this.end = Math.max(...this.peaks.map(p => p.retentionTime + 8 * p.halfWidth))
    }

    /** seconds since the injection */
    get time(): number { return (Date.now() - this.injected) / 1000 }
    get finished(): boolean { return this.time > this.end }

    static band(p: Peak, wavelength: number): number { return Math.exp(-((wavelength - p.wavelength) ** 2) / (2 * p.bandWidth ** 2)) }
    static profile(p: Peak, t: number): number { return 1 / (1 + ((t - p.retentionTime) / p.halfWidth) ** 2) }

    /** absorbance [mAU] at the given wavelength, now (or at time t after the injection) */
    signal(wavelength: number, t = this.time): number {
        return this.peaks.reduce((sum, p) => sum + p.height * Chromatogram.profile(p, t) * Chromatogram.band(p, wavelength), 0)
    }

    /** peak values at a detector wavelength: maximum time, height, width (FWHM), area */
    static evaluate(p: Peak, wavelength: number) {
        const height = p.height * Chromatogram.band(p, wavelength)
        return { retentionTime: p.retentionTime, height, width: 2 * p.halfWidth, area: Math.PI * height * p.halfWidth }
    }
}
