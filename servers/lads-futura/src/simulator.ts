// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Time-lapse simulator for the Futura Connect Xtra server.
Created programmatically as a "Simulator" BaseObject below the device (own namespace, not part of the Aber model).

Process time advances as  processHours = realSeconds * TimeLapse / 3600.
Data source: a CSV file (columns: time_h, capacitance, conductivity, temperature; header optional, linear interpolation)
or, without a file, a built-in 250 h batch (growth, peak at about 145 h, decline; 37 degC).

The SPECTRA values are derived from a physical model (FUTURA SPECTRA User Manual 2819-09-00, sections 13 and 14):
  Eq. 7  Cole-Cole function C(f) = dC [1 + (f/fc)^(1-a) sin(a pi/2)] / [1 + 2 (f/fc)^(1-a) sin(a pi/2) + (f/fc)^(2(1-a))] + Cinf
  Eq. 8  dC = 9 P r Cm / 4                       (P volume fraction, r cell radius, Cm membrane capacitance)
  Eq. 9  fc = 1 / (2 pi r Cm (1/sigma_i + 1/(2 sigma_e)))
The probe capacitance is C(580 kHz); the model is inverted (capacitance -> dC -> P, cell number, ...).
Cole-Cole alpha is empirical (no closed formula in the manual) and follows a typical time course.
*/

import { AccessLevelFlag, DataType, DataValue, LocalizedText, StatusCodes, UAMethod, UAObject, UAVariable, Variant, AddressSpace, Namespace, CallMethodResultOptions } from "node-opcua"
import { readFileSync } from "fs"
import { promoteToFiniteStateMachine } from "@utils"
import { LADSFunctionalState } from "@interfaces"

interface Sample { t: number, cap: number, cond: number, temp: number }
const SCAN_FREQUENCIES = Array.from({ length: 25 }, (_, i) => Math.round(50 * Math.pow(20000 / 50, i / 24)))   // kHz, log spaced 50 .. 20000
const MEASURING_FREQUENCY = 580   // kHz

// ---------------------------------------------------------------- physical model
const DURATION_H = 250
const MEMBRANE_CAPACITANCE = 1.0   // Cm in uF/cm^2 (user parameter, default 1.0)
const SIGMA_INTERNAL = 2.5         // cytoplasm conductivity in mS/cm (animal cells: 2 - 3)
const C_INFINITY = 4               // background capacitance of the suspension in pF/cm (also the zero of the biomass)
const DELTA_C_PEAK = 250           // pF/cm at the maximum of the batch

// smooth curve (cubic Hermite, finite-difference tangents) through anchor points [time h, value]
function curve(points: [number, number][], t: number): number {
    const n = points.length
    if (t <= points[0][0]) return points[0][1]
    if (t >= points[n - 1][0]) return points[n - 1][1]
    let i = 1
    while (points[i][0] < t) i++
    const [x0, y0] = points[i - 1], [x1, y1] = points[i]
    const slope = (k: number) => { const a = points[Math.max(k - 1, 0)], b = points[Math.min(k + 1, n - 1)]; return (b[1] - a[1]) / (b[0] - a[0]) }
    const h = x1 - x0, u = (t - x0) / h
    return (2 * u ** 3 - 3 * u ** 2 + 1) * y0 + (u ** 3 - 2 * u ** 2 + u) * h * slope(i - 1) + (-2 * u ** 3 + 3 * u ** 2) * y1 + (u ** 3 - u ** 2) * h * slope(i)
}
// typical animal-cell batch: dC relative to its maximum, Cole-Cole alpha, cell radius in um
const DELTA_C_SHAPE: [number, number][] = [[0, 0.004], [25, 0.05], [50, 0.16], [75, 0.30], [100, 0.47], [120, 0.72], [135, 0.93], [145, 1], [160, 0.93], [180, 0.80], [200, 0.70], [225, 0.60], [250, 0.54]]
const ALPHA_CURVE: [number, number][] = [[0, 0.30], [15, 0.22], [40, 0.15], [80, 0.08], [120, 0.05], [145, 0.045], [180, 0.06], [220, 0.08], [250, 0.09]]
const RADIUS_CURVE: [number, number][] = [[0, 7], [100, 7], [120, 6.95], [185, 6.0], [250, 5.0]]

// normalised real part of Eq. 7 (1 at 0 Hz, 0 at infinite frequency)
const dispersion = (f: number, fc: number, alpha: number) => {
    const x = Math.pow(f / fc, 1 - alpha), sn = Math.sin(alpha * Math.PI / 2)
    return (1 + x * sn) / (1 + 2 * x * sn + x * x)
}
// Eq. 9, r in um, sigma_e in mS/cm -> kHz
const characteristicFrequency = (rUm: number, sigmaE: number) =>
    1 / (2 * Math.PI * (rUm * 1e-4) * (MEMBRANE_CAPACITANCE * 1e-6) * (1 / (SIGMA_INTERNAL * 1e-3) + 1 / (2 * sigmaE * 1e-3))) / 1e3
// conductivity increment of the dispersion (Kramers-Kronig): 2 pi fc dC, in mS/cm for fc in kHz and dC in pF/cm
const conductivityStep = (fc: number, deltaC: number) => 2 * Math.PI * fc * deltaC * 1e-6

interface Fit { r: number, alpha: number, fc: number, deltaC: number, P: number, sigmaLow: number, sigmaE: number }

// inversion of the model: probe capacitance (at the measuring frequency) and conductivity -> Cole-Cole parameters and cell data
function solveModel(cap: number, cond: number, t: number): Fit {
    const r = curve(RADIUS_CURVE, t), alpha = curve(ALPHA_CURVE, t)
    let sigmaE = cond, fc = 0, deltaC = 0, P = 0, sigmaLow = cond
    for (let k = 0; k < 4; k++) {
        fc = characteristicFrequency(r, sigmaE)
        const d = dispersion(MEASURING_FREQUENCY, fc, alpha)
        deltaC = Math.max(0, cap - C_INFINITY) / d
        P = Math.min(0.6, 4 * deltaC / (9 * (r * 1e-4) * MEMBRANE_CAPACITANCE * 1e6))                     // Eq. 8
        sigmaLow = cond - conductivityStep(fc, deltaC) * (1 - d)
        sigmaE = sigmaLow * (1 + P / 2) / (1 - P)                                                             // Maxwell: suspension of non-conducting spheres
    }
    return { r, alpha, fc, deltaC, P, sigmaLow, sigmaE }
}

function builtInProfile(): Sample[] {
    const out: Sample[] = []
    for (let t = 0; t <= DURATION_H; t += 0.5) {
        const shape = curve(DELTA_C_SHAPE, t)
        const cond = 11.5 - 1.8 * shape - 0.004 * t                  // suspension conductivity, mS/cm
        const fc = characteristicFrequency(curve(RADIUS_CURVE, t), cond)
        const cap = C_INFINITY + DELTA_C_PEAK * shape * dispersion(MEASURING_FREQUENCY, fc, curve(ALPHA_CURVE, t))
        out.push({ t, cap, cond, temp: 37.0 })
    }
    return out
}

function loadCsv(path: string): Sample[] {
    const rows: Sample[] = []
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
        const f = line.trim().split(/[;,\t]/).map(Number)
        if (f.length >= 2 && f.every(x => !isNaN(x))) rows.push({ t: f[0], cap: f[1], cond: f[2] ?? 10, temp: f[3] ?? 37 })
    }
    if (rows.length < 2) throw new Error(`no usable data rows in ${path}`)
    return rows.sort((a, b) => a.t - b.t)
}

function interpolate(profile: Sample[], t: number): Sample {
    if (t <= profile[0].t) return profile[0]
    for (let i = 1; i < profile.length; i++) {
        if (t <= profile[i].t) {
            const a = profile[i - 1], b = profile[i], w = (t - a.t) / (b.t - a.t || 1)
            return { t, cap: a.cap + w * (b.cap - a.cap), cond: a.cond + w * (b.cond - a.cond), temp: a.temp + w * (b.temp - a.temp) }
        }
    }
    return profile[profile.length - 1]
}

const noise = (amplitude: number) => (Math.random() - 0.5) * 2 * amplitude

export class FuturaSimulator {
    private timer?: NodeJS.Timeout
    private profile: Sample[]
    private lastTick = 0
    private processHours = 0
    private timeLapse = 600           // 1 real second = 10 process minutes
    private loop = true
    private spectraInstalled = false
    private status = "Stopped"
    private variables: Record<string, UAVariable> = {}

    constructor(private addressSpace: AddressSpace, private device: UAObject, dataFile?: string) {
        this.profile = dataFile ? loadCsv(dataFile) : builtInProfile()
        this.sourceName = dataFile ?? "built-in fed-batch profile"
        this.createNodes()
        // factory calibration of the biomass: ZeroValue = background capacitance of the medium, multiplier 1.0 = 10^6 cells/ml per pF/cm (manual 2.2, cell culture)
        const calibration = this.find(this.futuraFunctions, "BioMassMeasurement", "CalibrationValues") as UAVariable
        calibration.setValueFromSource({ dataType: DataType.Double, arrayType: 1 as any, value: Float64Array.from([C_INFINITY, 1.0]) } as any)
    }
    private sourceName: string

    // ---------------------------------------------------------------- helpers
    private find(root: UAObject, ...path: string[]): any {
        let n: any = root
        for (const p of path) { n = n?.getChildByName(p); if (!n) throw new Error(`simulator: node ${path.join("/")} not found`) }
        return n
    }
    private setDouble(v: UAVariable, value: number) { v.setValueFromSource({ dataType: DataType.Double, value }) }
    private get futuraFunctions(): UAObject { return this.find(this.device, "FunctionalUnitSet", "Futura", "FunctionSet") }
    private get spectraUnit(): UAObject { return this.find(this.device, "FunctionalUnitSet", "Spectra") }
    private get futuraUnit(): UAObject { return this.find(this.device, "FunctionalUnitSet", "Futura") }

    // ---------------------------------------------------------------- Simulator object
    private createNodes() {
        const ns: Namespace = this.addressSpace.registerNamespace("http://aberinstruments.com/FuturaConnect/Simulator")
        const sim = ns.addObject({ browseName: "Simulator", organizedBy: undefined as any, componentOf: this.device, description: { text: "Time-lapse simulation of a fermentation based on recorded or built-in data" } })
        const rw = AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        const add = (name: string, dataType: string, get: () => any, set?: (v: any) => void, description?: string, unit?: string) => {
            const v = ns.addVariable({
                browseName: name, componentOf: sim, dataType, description: description ? { text: description } : undefined,
                accessLevel: set ? rw : AccessLevelFlag.CurrentRead, userAccessLevel: set ? rw : AccessLevelFlag.CurrentRead,
                value: {
                    get: () => new Variant({ dataType: dataType === "Boolean" ? DataType.Boolean : dataType === "String" ? DataType.String : DataType.Double, value: get() }),
                    set: set ? (variant: Variant) => { set(variant.value); return StatusCodes.Good } : undefined,
                },
            })
            this.variables[name] = v
        }
        add("Status", "String", () => this.status, undefined, "Stopped, Running or Finished")
        add("TimeLapse", "Double", () => this.timeLapse, v => { this.timeLapse = Math.max(0, Number(v)) }, "Time-lapse factor: process seconds per real second (600 = 10 process minutes per second)")
        add("ProcessTime", "Double", () => this.processHours, undefined, "Elapsed process time in hours")
        add("Loop", "Boolean", () => this.loop, v => { this.loop = !!v }, "Restart at the beginning when the data end is reached")
        add("SpectraInstalled", "Boolean", () => this.spectraInstalled, v => { this.setSpectra(!!v) }, "Simulates an installed SPECTRA: enables the SPECTRA functions and sets its unit to Running while the simulation runs")
        add("DataSource", "String", () => this.sourceName, undefined, "CSV file or built-in profile")
        add("Duration", "Double", () => this.profile[this.profile.length - 1].t, undefined, "Length of the data in process hours")

        const method = (name: string, description: string, fn: () => void) => {
            const m = ns.addMethod(sim, { browseName: name, description: { text: description }, inputArguments: [], outputArguments: [] })
            m.bindMethod((_inputs, _context, callback) => { try { fn(); callback(null, { statusCode: StatusCodes.Good } as CallMethodResultOptions) } catch (e) { callback(null, { statusCode: StatusCodes.BadInternalError }) } })
        }
        method("Start", "Starts or resumes the simulation", () => this.start())
        method("Stop", "Stops the simulation and keeps the process time", () => this.stop())
        method("Reset", "Stops the simulation and sets the process time to zero", () => { this.stop(); this.processHours = 0; this.apply() })
        this.setSpectra(true)    // SPECTRA is installed by default (calls apply())
    }

    // ---------------------------------------------------------------- control
    start() {
        if (this.timer) return
        this.status = "Running"
        this.lastTick = Date.now()
        this.setUnitState(this.futuraUnit, LADSFunctionalState.Running)
        if (this.spectraInstalled) this.setUnitState(this.spectraUnit, LADSFunctionalState.Running)
        this.timer = setInterval(() => this.tick(), 500)
    }
    stop(finished = false) {
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
        this.status = finished ? "Finished" : "Stopped"
        this.setUnitState(this.futuraUnit, LADSFunctionalState.Stopped)
        this.setUnitState(this.spectraUnit, LADSFunctionalState.Stopped)
    }
    private setUnitState(unit: UAObject, state: LADSFunctionalState) {
        try { promoteToFiniteStateMachine(this.find(unit, "FunctionalUnitState")).setState(state) } catch { /* state machine not available */ }
    }
    private setSpectra(on: boolean) {
        this.spectraInstalled = on
        const fs = this.find(this.spectraUnit, "FunctionSet")
        for (const f of fs.getComponents()) {
            const e = f.getChildByName("IsEnabled")
            e?.setValueFromSource({ dataType: DataType.Boolean, value: on })
        }
        if (this.timer) this.setUnitState(this.spectraUnit, on ? LADSFunctionalState.Running : LADSFunctionalState.Stopped)
        this.apply()
    }

    private tick() {
        const now = Date.now()
        this.processHours += (now - this.lastTick) / 1000 * this.timeLapse / 3600
        this.lastTick = now
        const end = this.profile[this.profile.length - 1].t
        if (this.processHours >= end) {
            if (this.loop) this.processHours = this.profile[0].t
            else { this.processHours = end; this.apply(); this.stop(true); return }
        }
        this.apply()
    }

    // ---------------------------------------------------------------- write values into the model
    private apply() {
        const s = interpolate(this.profile, this.processHours)
        const fs = this.futuraFunctions
        const value = (fn: string) => this.find(fs, fn, "SensorValue") as UAVariable
        const cap = Math.max(0, s.cap + noise(0.003 * s.cap + 0.02))
        const cond = s.cond + noise(0.02)
        this.setDouble(value("Capacitance"), cap)
        this.setDouble(value("Conductivity"), cond)
        // BioMassMeasurement = (Capacitance - ZeroValue) x BioMassMultiplier, both from CalibrationValues (client writable)
        const calibration = this.find(fs, "BioMassMeasurement", "CalibrationValues").readValue().value.value as ArrayLike<number> | null
        const zero = calibration?.[0] ?? 0, multiplier = calibration?.[1] ?? 1
        this.setDouble(value("BioMassMeasurement"), Math.max(0, cap - zero) * multiplier)
        this.setDouble(value("ProbeTemperature"), s.temp + noise(0.05))
        this.setDouble(value("ElectronicsTemperature"), 31 + 0.02 * Math.min(this.processHours, 60) + noise(0.03))
        // probe operation duration (ms)
        try { this.find(this.device, "Components", "Probe", "OperationCounters", "OperationDuration").setValueFromSource({ dataType: DataType.Double, value: this.processHours * 3600000 }) } catch { /* optional */ }

        if (this.spectraInstalled) this.applySpectra(s.cap, s.cond)
    }

    // SPECTRA values from the model (Eq. 7 - 9); capacitance and conductivity are the noise-free probe values
    private applySpectra(cap: number, cond: number) {
        const m = solveModel(cap, cond, this.processHours)
        const fs = this.find(this.spectraUnit, "FunctionSet")
        const setArray = (name: string, arr: number[]) => (this.find(fs, name, "SensorValue") as UAVariable).setValueFromSource({ dataType: DataType.Double, arrayType: 1 as any, value: Float64Array.from(arr) } as any)
        const setScalar = (name: string, v: number) => this.setDouble(this.find(fs, name, "SensorValue"), v)
        setArray("ScanFrequencies", SCAN_FREQUENCIES)
        setArray("ScanCapacitance", SCAN_FREQUENCIES.map(f => C_INFINITY + m.deltaC * dispersion(f, m.fc, m.alpha) + noise(0.002 * cap + 0.01)))
        setArray("ScanConductivity", SCAN_FREQUENCIES.map(f => m.sigmaLow + conductivityStep(m.fc, m.deltaC) * (1 - dispersion(f, m.fc, m.alpha)) + noise(0.01)))
        setScalar("DeltaCapacitance", m.deltaC)
        setScalar("CriticalFrequency", m.fc)
        setScalar("ColeColeAlpha", m.alpha)
        setScalar("QualityOfFit", 0.995 + noise(0.003))
        setScalar("CellDiameter", 2 * m.r + noise(0.05))
        setScalar("CapacitanceInfinity", C_INFINITY)
        setScalar("InternalConductivity", SIGMA_INTERNAL)
        setScalar("SuspensionConductivity", m.sigmaLow)
        setScalar("MediumConductivity", m.sigmaE)
        setScalar("DerivedBiomass", m.P / (4 / 3 * Math.PI * Math.pow(m.r * 1e-4, 3)) / 1e6)       // million cells/ml (DerivedBiomassType 0)
        const before = interpolate(this.profile, Math.max(this.profile[0].t, this.processHours - 0.5)).cap
        setScalar("CapacitanceRate", (cap - before) / Math.min(0.5, Math.max(this.processHours - this.profile[0].t, 0.01)))   // pF/cm per h
    }
}
