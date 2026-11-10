// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Time-lapse simulator for the Futura Connect Xtra server.
Created programmatically as a "Simulator" BaseObject below the device (own namespace, not part of the Aber model).

Process time advances as  processHours = realSeconds * TimeLapse / 3600.
Data source: a CSV file (columns: time_h, capacitance, conductivity, temperature; header optional, linear interpolation)
or, without a file, a built-in fed-batch growth curve (logistic capacitance, slowly falling conductivity, 37 degC).
*/

import { AccessLevelFlag, DataType, DataValue, LocalizedText, StatusCodes, UAMethod, UAObject, UAVariable, Variant, AddressSpace, Namespace, CallMethodResultOptions } from "node-opcua"
import { readFileSync } from "fs"
import { promoteToFiniteStateMachine } from "@utils"
import { LADSFunctionalState } from "@interfaces"

interface Sample { t: number, cap: number, cond: number, temp: number }
const SCAN_FREQUENCIES = Array.from({ length: 25 }, (_, i) => Math.round(50 * Math.pow(20000 / 50, i / 24)))   // kHz, log spaced 50 .. 20000
const MEASURING_FREQUENCY = 580   // kHz

function builtInProfile(): Sample[] {
    // 120 h batch: lag ~15 h, exponential phase, plateau; capacitance in pF/cm
    const out: Sample[] = []
    for (let t = 0; t <= 120; t += 0.5) {
        const growth = 1 / (1 + Math.exp(-0.11 * (t - 55)))
        out.push({ t, cap: 4 + 190 * growth, cond: 11.5 - 1.8 * growth - 0.004 * t, temp: 37.0 })
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
        this.setDouble(value("BioMassMeasurement"), Math.max(0, cap - 4) * 1.0)    // zero 4 pF/cm, multiplier 1.0
        this.setDouble(value("ProbeTemperature"), s.temp + noise(0.05))
        this.setDouble(value("ElectronicsTemperature"), 31 + 0.02 * Math.min(this.processHours, 60) + noise(0.03))
        // probe operation duration (ms)
        try { this.find(this.device, "Components", "Probe", "OperationCounters", "OperationDuration").setValueFromSource({ dataType: DataType.Double, value: this.processHours * 3600000 }) } catch { /* optional */ }

        if (this.spectraInstalled) this.applySpectra(cap, cond)
    }

    // Cole-Cole type dispersion with fc = 1500 kHz, scaled so that C(580 kHz) equals the measured capacitance
    private applySpectra(cap: number, cond: number) {
        const alpha = 0.1, fc = 1500
        const disp = (f: number) => 1 / (1 + Math.pow(f / fc, 2 * (1 - alpha)))
        const deltaC = cap / disp(MEASURING_FREQUENCY)
        const fs = this.find(this.spectraUnit, "FunctionSet")
        const setArray = (name: string, arr: number[]) => (this.find(fs, name, "SensorValue") as UAVariable).setValueFromSource({ dataType: DataType.Double, arrayType: 1 as any, value: Float64Array.from(arr) } as any)
        const setScalar = (name: string, v: number) => this.setDouble(this.find(fs, name, "SensorValue"), v)
        setArray("ScanFrequencies", SCAN_FREQUENCIES)
        setArray("ScanCapacitance", SCAN_FREQUENCIES.map(f => deltaC * disp(f) + noise(0.002 * cap + 0.01)))
        setArray("ScanConductivity", SCAN_FREQUENCIES.map(f => cond * (1 + 0.1 * (1 - disp(f))) + noise(0.01)))
        setScalar("DeltaCapacitance", deltaC)
        setScalar("CriticalFrequency", fc)
        setScalar("ColeColeAlpha", alpha)
        setScalar("QualityOfFit", 0.995 + noise(0.003))
        setScalar("CellDiameter", 15 + noise(0.2))
        setScalar("CapacitanceInfinity", 0)
        setScalar("InternalConductivity", 0.6 * cond)
        setScalar("SuspensionConductivity", cond)
        setScalar("MediumConductivity", cond * 1.05)
        setScalar("DerivedBiomass", Math.max(0, deltaC - 4) * 0.5)
        setScalar("dCapDt", 0)
    }
}
