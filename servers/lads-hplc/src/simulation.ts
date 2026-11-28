// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Simulation loop of the HPLC unit: column oven and pump.

  - Simulator object (programmatic, below the functional unit, as in the other example servers) with the settable
    simulation parameters: Ambient Temperature, Oven Time Constant, Flow Resistance, Pump Time Constant
  - ColumnOven (AnalogControlFunction): PT1 behaviour of the oven compartment,
        dT/dt = (T_target - T) / tau   while the controller runs,
        dT/dt = (T_ambient - T) / tau  while it is stopped (the compartment cools down to the ambient temperature)
  - Pump (control function, CurrentValue = flow): the flow follows the TargetValue with a short PT1 while running and
    falls to 0 when stopped; the sensor value of its sub-function Pressure = flow × flow resistance
  - Pump (AnalogControlFunctionWithComposedTargetValue): the partial target values of its TargetValueSet are written by
    clients (TargetValue itself is read-only); Flow is the flow set point and is copied to TargetValue, PercentageSolventB
    is kept for the gradient (not simulated yet)
  - Pump sub-functions Solvent A / Solvent B (AnalogControlFunctions below Pump/FunctionSet): no commands, TargetValue
    read-only; TargetValue = pump TargetValue × share, CurrentValue = pump CurrentValue × share (share of B =
    PercentageSolventB, default 10 %, A = the rest), CurrentValue historized; ControlFunctionState = that of the pump
  - CurrentValue of the column oven and of the pump are historized (HistoryRead), as the pressure SensorValue
  - Valve (ports) and SamplePosition (24 tray positions), both MultiStateDiscreteControlFunctions: no Start / Stop; a write
    of TargetValue sets ControlFunctionState to Running, CurrentValue moves one position every 0.5 s towards TargetValue,
    then Stopped
  - SampleInjector (AnalogControlFunctionWithRelativeTargetValue, volume in µl): Start runs one injection cycle:
    Running -> aspirate (CurrentValue up to TargetValue with IncreaseRate) -> move the injector from the sample into the
    HPLC stream (Injector Move Time, 2 s) -> dispense (CurrentValue down to 0 with DecreaseRate) -> Stopped. Stop ends the
    cycle at once
  - both controllers can be started and stopped individually; linked to the unit as in the viscometer: a start by hand
    sets the unit from Stopped to Running (refused while the unit is Aborted, Stopping ...), stopping the last of them by
    hand without a run sets it back to Stopped (SimulatedUnitImpl.controllerStartedByHand / controllerStoppedByHand);
    they are started together with a program run of the unit and stopped when the run ends, is stopped or aborted
  - detectors (chromatography.ts): every completed injection creates a chromatogram (dead time = Dead Volume / flow, peaks
    within the Elution Window); the DAD channels DAD1A … D show its absorbance at their wavelength, DAD1I the spectrum
    (250 ms, SensorValues historized)
  - processSample(): one sample of a program run: move to its tray position, inject, record the chromatogram; the
    composition of the run sets PercentageSolventB (isocratic) or ramps it linearly during the separation (gradient)
*/

import { AccessLevelFlag, CallMethodResultOptions, DataType, ISessionContext, makeEUInformation, StatusCodes, UAObject, UAVariable, VariantArrayType, VariantLike } from "node-opcua"
import { EUInformation, Range } from "node-opcua-types"
import { LADSAnalogControlFunction, LADSFunctionalUnit } from "@interfaces"
import { AnalogControlFunctionImpl, AnalogScalarSensorFunctionImpl, EventSeverity, getNumericValue, installVariableHistory, promoteToFiniteStateMachine, raiseEvent, restrictAvailableStatesAndTransitions, setNumericValue } from "@utils"
import { AccessPredicate, restrictWriteAccess } from "./locks"
import { Chromatogram } from "./chromatography"
import type { Composition } from "./unit"
import { ColumnOvenAlarm, PressureAlarm } from "./alarms"

/** a detector channel of the DAD */
export interface DetectorChannel { name: string, wavelength: number, sensorValue: UAVariable }

/** mAU (no UNECE code) */
export const mAU = new EUInformation({ namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact", unitId: -1, displayName: { text: "mAU" }, description: { text: "milli absorbance unit" } })

/** the unit side of the link (SimulatedUnitImpl) */
export interface UnitLink { controllerStartedByHand(controller: string): boolean; controllerStoppedByHand(): void }

const TICK_MS = 500
const VALVE_STEP_MS = 500
const DETECTOR_MS = 250
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class HPLCSimulation {
    readonly oven?: AnalogControlFunctionImpl
    readonly pump?: AnalogControlFunctionImpl
    readonly pressure?: AnalogScalarSensorFunctionImpl
    readonly injector?: AnalogControlFunctionImpl
    readonly ovenAlarm?: ColumnOvenAlarm
    readonly pressureAlarm?: PressureAlarm
    private percentB?: UAVariable
    private solvents: { share: (b: number) => number, target: UAVariable, current: UAVariable, state: any }[] = []
    private increaseRate?: UAVariable
    private decreaseRate?: UAVariable
    /** phase of the injection cycle of the sample injector (undefined while its controller is stopped) */
    private injection?: { phase: "aspirate" | "move" | "dispense", since: number }
    readonly parameters: { [name: string]: UAVariable } = {}
    private steppers: { [name: string]: { target: UAVariable, current: UAVariable, sm: any, positions: number } } = {}
    readonly channels: DetectorChannel[] = []
    private spectrum?: { sensorValue: UAVariable, from: number, step: number, n: number }
    private chromatograms: Chromatogram[] = []
    private lastChromatogram?: Chromatogram
    private injectedSample = "manual injection"
    private detectorTimer: NodeJS.Timeout
    private timer: NodeJS.Timeout
    /** set by the device: the functional unit whose state follows the linked controllers (column oven, pump) */
    unitLink?: UnitLink

    constructor(readonly unit: LADSFunctionalUnit, private readonly isAccessible: AccessPredicate) {
        const fs = (unit as unknown as UAObject).getChildByName("FunctionSet") as UAObject
        const ovenNode = fs?.getChildByName("ColumnOven") as unknown as LADSAnalogControlFunction
        const pumpNode = fs?.getChildByName("Pump") as unknown as LADSAnalogControlFunction
        const pressureNode = (pumpNode as unknown as UAObject)?.getChildByName("FunctionSet")?.getChildByName("Pressure")
        if (ovenNode) this.oven = this.controller(ovenNode, true)
        if (pumpNode) this.pump = this.controller(pumpNode, true)
        if (pressureNode) this.pressure = new AnalogScalarSensorFunctionImpl(pressureNode as any)   // historizes its SensorValue
        for (const c of [this.oven, this.pump]) if (c) installVariableHistory(c.currentValue as unknown as UAVariable)
        if (ovenNode) this.ovenAlarm = new ColumnOvenAlarm(ovenNode)             // AlarmMonitor (ExclusiveDeviationAlarm)
        if (pressureNode) this.pressureAlarm = new PressureAlarm(pressureNode as any)   // AlarmMonitor (ExclusiveLevelAlarm)
        for (const name of ["Valve", "SamplePosition"]) {
            const node = fs?.getChildByName(name) as UAObject | null
            if (node) this.installStepper(node)
        }
        const injectorNode = fs?.getChildByName("SampleInjector") as unknown as LADSAnalogControlFunction
        if (injectorNode) this.injector = this.installDosing(injectorNode)
        const dad = fs?.getChildByName("DAD") as UAObject | null
        if (dad) this.installDetectors(dad)

        // simulator object with the settable parameters
        const ns = (unit as unknown as UAObject).namespace
        const simulator = ns.addObject({ componentOf: unit as unknown as UAObject, browseName: "Simulator", description: "Simulation of the column oven (PT1) and of the pump pressure (flow × flow resistance)." })
        const add = (name: string, value: number, description: string) => {
            this.parameters[name] = ns.addVariable({
                componentOf: simulator, browseName: name, description, dataType: DataType.Double,
                value: { dataType: DataType.Double, value },
                accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite, userAccessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite,
            })
        }
        add("Ambient Temperature", 22, "Ambient temperature of the lab [°C]: the oven compartment cools down to it while the column oven is stopped")
        add("Oven Time Constant", 60, "Time constant of the oven compartment [s] (PT1)")
        add("Flow Resistance", 100, "Flow resistance of the column [bar per mL/min]: pressure = flow × flow resistance")
        add("Pump Time Constant", 2, "Time constant of the pump flow [s] (PT1)")
        add("Injector Move Time", 2, "Time the sample injector needs to move from the sample into the HPLC stream [s]")
        add("Dead Volume", 166.7, "Dead volume between injector and detector [µl]: dead time = dead volume / flow (10 s at 1 ml/min)")
        add("Elution Window", 50, "Time span in which the peaks of a sample elute at 1 ml/min [s] (scales with 1 / flow)")
        add("Detector Noise", 0.3, "Noise of the DAD signals [mAU] (peak to peak)")

        // start values: oven at ambient temperature, pump without flow; sensible set points if the nodeset has none
        const ambient = this.param("Ambient Temperature")
        if (this.oven) {
            setNumericValue(this.oven.currentValue, ambient)
            if (!getNumericValue(this.oven.targetValue)) setNumericValue(this.oven.targetValue, 40)
        }
        if (this.pump) {
            setNumericValue(this.pump.currentValue, 0)
            if (!getNumericValue(this.pump.targetValue)) setNumericValue(this.pump.targetValue, 1.0)
            this.installComposedTargetValue(pumpNode as unknown as UAObject)
            this.installSolvents(pumpNode as unknown as UAObject)
        }
        if (this.pressure) setNumericValue(this.pressure.sensorValue, 0)
        console.log(`Simulation: oven ${this.oven ? "yes" : "no"}, pump ${this.pump ? "yes" : "no"}, pressure ${this.pressure ? "yes" : "no"}`)

        let last = Date.now()
        this.timer = setInterval(() => { const now = Date.now(); this.evaluate((now - last) / 1000); last = now }, TICK_MS)
        this.detectorTimer = setInterval(() => this.evaluateDetectors(), DETECTOR_MS)
    }

    /** control function with lock check on Start / Stop and on writes of its TargetValue */
    private controller(node: LADSAnalogControlFunction, linked = false): AnalogControlFunctionImpl {
        const impl = new AnalogControlFunctionImpl(node)
        impl.stateMachine.setState("Stopped")
        const state = node.controlFunctionState as any
        const name = (node as unknown as UAObject).getDisplayName()
        state.start?.bindMethod(async (_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> => {
            if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
            if (this.running(impl)) return { statusCode: StatusCodes.BadInvalidState }
            if (linked && this.unitLink && !this.unitLink.controllerStartedByHand(name)) return { statusCode: StatusCodes.BadInvalidState }
            this.start(impl, `${name} started`)
            return { statusCode: StatusCodes.Good }
        })
        state.stop?.bindMethod(async (_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> => {
            if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
            if (!this.running(impl)) return { statusCode: StatusCodes.BadInvalidState }
            this.stop(impl, `${name} stopped`)
            if (linked) this.unitLink?.controllerStoppedByHand()
            return { statusCode: StatusCodes.Good }
        })
        restrictWriteAccess(node.targetValue as unknown as UAVariable, this.isAccessible)
        return impl
    }

    /**
     * MultiStateDiscreteControlFunction that moves stepwise (valve ports, autosampler positions): no Start / Stop; a new
     * TargetValue sets ControlFunctionState to Running, CurrentValue moves one position every 0.5 s towards it, then
     * Stopped. A new TargetValue while moving changes the goal.
     */
    private installStepper(valve: UAObject) {
        const target = valve.getChildByName("TargetValue") as UAVariable
        const current = valve.getChildByName("CurrentValue") as UAVariable
        const state = valve.getChildByName("ControlFunctionState") as UAObject
        if (!target || !current || !state) return
        const sm = promoteToFiniteStateMachine(state as any)
        sm.setState("Stopped")
        restrictAvailableStatesAndTransitions(sm, ["Running", "Stopped"], [])
        restrictWriteAccess(target, this.isAccessible)   // the lock of the unit applies
        const value = (v: UAVariable) => Number(v.readValue().value.value ?? 0)
        const dataType = current.readValue().value.dataType || DataType.UInt32
        if (current.readValue().value.value == null) current.setValueFromSource({ dataType, value: 0 })
        if (target.readValue().value.value == null) target.setValueFromSource({ dataType, value: 0 })
        const ports = ((current.getChildByName("EnumStrings") as UAVariable)?.readValue().value.value as { text: string }[] | null) ?? []
        this.steppers[valve.browseName.name!] = { target, current, sm, positions: ports.length }
        const label = (i: number) => ports[i]?.text ?? String(i)
        let timer: NodeJS.Timeout | undefined
        const step = () => {
            const goal = value(target), now = value(current)
            const next = now === goal ? now : now + Math.sign(goal - now)
            if (next !== now) current.setValueFromSource({ dataType, value: next })
            if (next === goal) {   // arrived: Stopped at once
                timer = undefined
                sm.setState("Stopped")
                raiseEvent(valve, `${valve.getDisplayName()} at ${label(goal)}`, EventSeverity.Info)
                return
            }
            timer = setTimeout(step, VALVE_STEP_MS)
        }
        target.on("value_changed", () => {
            if (timer || value(target) === value(current)) return
            sm.setState("Running")
            raiseEvent(valve, `${valve.getDisplayName()} moving from ${label(value(current))} to ${label(value(target))}`, EventSeverity.Info)
            timer = setTimeout(step, VALVE_STEP_MS)
        })
    }

    /** SampleInjector dosing: controller (Start / Stop, lock) and rates */
    private installDosing(node: LADSAnalogControlFunction): AnalogControlFunctionImpl {
        const impl = this.controller(node)
        const obj = node as unknown as UAObject
        this.increaseRate = obj.getChildByName("IncreaseRate") as UAVariable | null ?? undefined
        this.decreaseRate = obj.getChildByName("DecreaseRate") as UAVariable | null ?? undefined
        for (const [v, d] of [[this.increaseRate, 5], [this.decreaseRate, 10]] as [UAVariable | undefined, number][]) {
            if (!v) continue
            restrictWriteAccess(v, this.isAccessible)
            if (!getNumericValue(v)) setNumericValue(v, d)
        }
        setNumericValue(impl.currentValue, 0)
        if (!getNumericValue(impl.targetValue)) setNumericValue(impl.targetValue, 50)   // default injection volume 50 µl
        return impl
    }

    /** Solvent A / B below the pump: read-only shares of the pump flow, state = pump state, history of CurrentValue */
    private installSolvents(pump: UAObject) {
        const fs = pump.getChildByName("FunctionSet") as UAObject | null
        for (const [name, share] of [["SolventA", (b: number) => 1 - b / 100], ["SolventB", (b: number) => b / 100]] as [string, (b: number) => number][]) {
            const node = fs?.getChildByName(name) as UAObject | null
            if (!node) continue
            const target = node.getChildByName("TargetValue") as UAVariable
            const current = node.getChildByName("CurrentValue") as UAVariable
            const state = promoteToFiniteStateMachine(node.getChildByName("ControlFunctionState") as any)
            restrictAvailableStatesAndTransitions(state, ["Running", "Stopped"], [])
            state.setState("Stopped")
            setNumericValue(current, 0)
            installVariableHistory(current)
            this.solvents.push({ share, target, current, state })
        }
    }

    /** composed target value of the pump: Flow (TargetValueSet) -> TargetValue; partial values follow the lock of the unit */
    private installComposedTargetValue(pump: UAObject) {
        const set = pump.getChildByName("TargetValueSet") as UAObject | null
        if (!set || !this.pump) return
        const flow = set.getChildByName("Flow") as UAVariable | null
        const percentB = set.getChildByName("PercentageSolventB") as UAVariable | null
        for (const v of [flow, percentB]) restrictWriteAccess(v, this.isAccessible)
        if (percentB && !getNumericValue(percentB)) setNumericValue(percentB, 10)   // default: 10 % solvent B
        this.percentB = percentB ?? undefined
        if (flow) {
            setNumericValue(flow, getNumericValue(this.pump.targetValue))
            flow.on("value_changed", () => setNumericValue(this.pump!.targetValue, getNumericValue(flow)))
        }
    }

    private running(c: AnalogControlFunctionImpl): boolean { return (c.stateMachine.getCurrentState() ?? "").includes("Running") }
    private start(c: AnalogControlFunctionImpl, message: string) {
        c.enterStart(); raiseEvent(c.controlFunction as unknown as UAObject, message, EventSeverity.Info)
        if (c === this.oven && this.ovenAlarm) { this.ovenAlarm.restart(); this.ovenAlarm.setEnabledState(true) }
    }
    private stop(c: AnalogControlFunctionImpl, message: string) {
        c.enterStop(); raiseEvent(c.controlFunction as unknown as UAObject, message, EventSeverity.Info)
        if (c === this.oven && this.ovenAlarm?.getEnabledState()) this.ovenAlarm.setEnabledState(false)
    }
    private param(name: string): number { return getNumericValue(this.parameters[name]) }

    /** with a program run of the unit: both controllers start (those not running yet) */
    startControllers() {
        for (const c of [this.oven, this.pump]) if (c && !this.running(c)) this.start(c, `${c.controlFunction.getDisplayName()} started with the run`)
        this.pressureAlarm?.arm()
    }
    anyControllerRunning(): boolean { return [this.oven, this.pump].some(c => c && this.running(c)) }

    /** end, stop or abort of the run: both controllers stop */
    stopControllers() {
        this.pressureAlarm?.disarm()
        for (const c of [this.oven, this.pump]) if (c && this.running(c)) this.stop(c, `${c.controlFunction.getDisplayName()} stopped with the run`)
    }

    /** default tolerance of the injection gate: the narrow band of the oven's AlarmMonitor (High / Low limit) */
    get ovenTolerance(): number | undefined { return this.ovenAlarm?.band }

    /**
     * Injection gate: waits until the column oven runs and has stayed within ±tolerance of its TargetValue for hold
     * seconds. progress() is called every tick; cancelled() ends the wait. ok = false after timeout seconds.
     */
    async waitForColumnOven(o: { tolerance: number, hold: number, timeout: number }, cancelled: () => boolean,
        progress: (current: number, target: number) => void): Promise<{ ok: boolean, waited: number, current: number, target: number, cancelled?: boolean }> {
        const t0 = Date.now()
        let inBandSince: number | undefined
        for (; ;) {
            const oven = this.oven
            const current = oven ? getNumericValue(oven.currentValue) : NaN, target = oven ? getNumericValue(oven.targetValue) : NaN
            const waited = (Date.now() - t0) / 1000
            if (!oven) return { ok: true, waited, current, target }
            if (cancelled()) return { ok: false, waited, current, target, cancelled: true }
            const inBand = this.running(oven) && Math.abs(current - target) <= o.tolerance
            inBandSince = inBand ? (inBandSince ?? Date.now()) : undefined
            if (inBandSince !== undefined && Date.now() - inBandSince >= o.hold * 1000) return { ok: true, waited, current, target }
            if (waited >= o.timeout) return { ok: false, waited, current, target }
            progress(current, target)
            await sleep(TICK_MS)
        }
    }

    private evaluate(dt: number) {
        const pt1 = (value: number, target: number, tau: number) => value + (target - value) * Math.min(1, dt / Math.max(tau, 1e-3))
        if (this.oven) {
            const target = this.running(this.oven) ? getNumericValue(this.oven.targetValue) : this.param("Ambient Temperature")
            setNumericValue(this.oven.currentValue, pt1(getNumericValue(this.oven.currentValue), target, this.param("Oven Time Constant")))
        }
        if (this.pump) {
            const target = this.running(this.pump) ? getNumericValue(this.pump.targetValue) : 0
            const flow = pt1(getNumericValue(this.pump.currentValue), target, this.param("Pump Time Constant"))
            setNumericValue(this.pump.currentValue, flow < 1e-4 ? 0 : flow)
            if (this.pressure) setNumericValue(this.pressure.sensorValue, flow * this.param("Flow Resistance"))
            const b = getNumericValue(this.percentB), pumpState = this.running(this.pump) ? "Running" : "Stopped"
            for (const s of this.solvents) {
                setNumericValue(s.target, getNumericValue(this.pump.targetValue) * s.share(b))
                setNumericValue(s.current, (flow < 1e-4 ? 0 : flow) * s.share(b))
                if (!(s.state.getCurrentState() ?? "").includes(pumpState)) s.state.setState(pumpState)   // follows the pump
            }
        }
        if (this.injector) this.evaluateInjection(dt)
    }

    /** one injection cycle per Start: aspirate -> move injector -> dispense -> Stopped */
    private evaluateInjection(dt: number) {
        const as = this.injector!
        if (!this.running(as)) { this.injection = undefined; return }   // stopped (also by Stop during a cycle)
        const obj = as.controlFunction as unknown as UAObject
        const enter = (phase: "aspirate" | "move" | "dispense", message: string) => {
            this.injection = { phase, since: Date.now() }
            raiseEvent(obj, message, EventSeverity.Info)
        }
        if (!this.injection) enter("aspirate", `${obj.getDisplayName()}: aspirating ${getNumericValue(as.targetValue)} µl`)
        const current = getNumericValue(as.currentValue)
        const ramp = (goal: number, rate: number) => {   // one step towards goal; true when it is reached
            const step = Math.max(0, rate) * dt
            const next = Math.abs(goal - current) <= step ? goal : current + Math.sign(goal - current) * step
            if (next !== current) setNumericValue(as.currentValue, next)
            return next === goal
        }
        switch (this.injection!.phase) {
            case "aspirate":
                if (ramp(getNumericValue(as.targetValue), getNumericValue(this.increaseRate))) enter("move", `${obj.getDisplayName()}: moving the injector into the HPLC stream`)
                break
            case "move":
                if (Date.now() - this.injection!.since >= this.param("Injector Move Time") * 1000) enter("dispense", `${obj.getDisplayName()}: dispensing ${current} µl`)
                break
            case "dispense":
                if (ramp(0, getNumericValue(this.decreaseRate))) {
                    this.injection = undefined
                    this.stop(as, `${obj.getDisplayName()}: injection done`)
                    this.startChromatogram()
                }
                break
        }
    }

    // ---------------------------------------------------------------- detectors
    private installDetectors(dad: UAObject) {
        const fs = dad.getChildByName("FunctionSet") as UAObject | null
        // wavelengths: from the channel components (Components/DAD/Components/DAD1A … Wavelength, DADChannelType); defaults
        // (the channels of the original model) are written there if a component has none
        const defaults: { [name: string]: number } = { DAD1A: 250, DAD1B: 320, DAD1C: 420, DAD1D: 480 }
        const device = ((this.unit as unknown as UAObject).parent as UAObject | null)?.parent as UAObject | null   // unit -> FunctionalUnitSet -> device
        const channelComponents = (device?.getChildByName("Components") as UAObject | null)?.getChildByName("DAD")?.getChildByName("Components") as UAObject | null
        const wavelengths: { [name: string]: number } = {}
        for (const [name, d] of Object.entries(defaults)) {
            const wl = (channelComponents?.getChildByName(name) as UAObject | null)?.getChildByName("Wavelength") as UAVariable | null
            const v = wl ? getNumericValue(wl) : 0
            if (wl && !v) setNumericValue(wl, d)
            wavelengths[name] = v || d
        }
        for (const f of (fs?.getComponents() ?? []) as UAObject[]) {
            const name = f.browseName.name!
            const sensorValue = f.getChildByName("SensorValue") as UAVariable | null
            if (!sensorValue) continue
            const eu = sensorValue.getChildByName("EngineeringUnits") as UAVariable | null
            eu?.setValueFromSource({ dataType: DataType.ExtensionObject, value: mAU })
            if (name in wavelengths) {
                const wl = sensorValue.getChildByName("Wavelength") as UAVariable | null
                wl?.setValueFromSource({ dataType: DataType.Double, value: wavelengths[name] })
                ;(wl?.getChildByName("EngineeringUnits") as UAVariable | null)?.setValueFromSource({ dataType: DataType.ExtensionObject, value: makeEUInformation("C45", "nm", "nanometre") })
                setNumericValue(sensorValue, 0)
                installVariableHistory(sensorValue)
                this.channels.push({ name, wavelength: wavelengths[name], sensorValue })
            } else if (name === "DAD1I") {   // spectrum 190 … 600 nm in 2 nm steps
                const from = 190, step = 2, n = 206
                try {   // Range (DataType Range, ValueRank -2): node-opcua refuses structures with ValueRank -2
                    ;(sensorValue.getChildByName("Range") as UAVariable | null)?.setValueFromSource({ dataType: DataType.ExtensionObject, value: new Range({ low: from, high: from + (n - 1) * step }) })
                } catch { console.warn(`DAD1I: Range not set (${from} … ${from + (n - 1) * step} nm)`) }
                ;(sensorValue.getChildByName("Step") as UAVariable | null)?.setValueFromSource({ dataType: DataType.Double, value: step })
                this.spectrum = { sensorValue, from, step, n }
            }
        }
        this.channels.sort((a, b) => a.wavelength - b.wavelength)
        console.log(`Detectors: ${this.channels.map(c => `${c.name} ${c.wavelength} nm`).join(", ")}${this.spectrum ? ", spectrum DAD1I" : ""}`)
    }

    /** a completed injection: the sample's chromatogram starts now */
    private startChromatogram() {
        const running = this.pump && this.running(this.pump)
        const flow = running ? getNumericValue(this.pump!.currentValue) : 0
        const sample = this.injectedSample
        this.injectedSample = "manual injection"
        const unit = this.unit as unknown as UAObject
        if (flow < 0.05) {
            raiseEvent(unit, `${sample}: injected without flow, the sample stays on the column`, EventSeverity.Warning)
            this.lastChromatogram = undefined
            return
        }
        const c = new Chromatogram(sample, { flow, deadVolume: this.param("Dead Volume"), elutionWindow: this.param("Elution Window") })
        c.injectionVolume = this.injector ? getNumericValue(this.injector.targetValue) : undefined
        c.columnTemperature = this.oven ? getNumericValue(this.oven.currentValue) : undefined
        c.percentB = this.percentB ? getNumericValue(this.percentB) : undefined
        this.chromatograms.push(c)
        this.lastChromatogram = c
        raiseEvent(unit, `${sample}: injected, dead time ${c.deadTime.toFixed(1)} s`, EventSeverity.Info)
    }

    private evaluateDetectors() {
        this.chromatograms = this.chromatograms.filter(c => !c.finished || c === this.lastChromatogram && c.time < c.end + 5)
        const noise = () => (Math.random() - 0.5) * this.param("Detector Noise")
        for (const ch of this.channels) setNumericValue(ch.sensorValue, this.chromatograms.reduce((s, c) => s + c.signal(ch.wavelength), 0) + noise())
        if (this.spectrum) {
            const { sensorValue, from, step, n } = this.spectrum
            const values = Float64Array.from({ length: n }, (_, i) => this.chromatograms.reduce((s, c) => s + c.signal(from + i * step), 0))
            sensorValue.setValueFromSource({ dataType: DataType.Double, arrayType: VariantArrayType.Array, value: values })
        }
    }

    // ---------------------------------------------------------------- one sample of a program run
    /**
     * Moves the tray to the sample's position, injects it and records its chromatogram. step() reports the phase,
     * cancelled() is polled (abort). Returns the chromatogram, or undefined if cancelled or nothing could be measured.
     */
    async processSample(sampleId: string, position: number, step: (phase: string) => void, cancelled: () => boolean, composition: Composition = {}): Promise<Chromatogram | undefined> {
        const setB = (v: number) => { if (this.percentB) setNumericValue(this.percentB, Math.round(v * 10) / 10) }
        if (composition.percentB !== undefined) setB(composition.percentB)          // isocratic: constant %B
        if (composition.gradient) setB(composition.gradient.from)                    // gradient: start composition
        const wait = async (done: () => boolean, timeoutMs: number) => {
            const t0 = Date.now()
            while (!done()) {
                if (cancelled() || Date.now() - t0 > timeoutMs) return false
                await sleep(200)
            }
            return true
        }
        // 1. tray position
        const tray = this.steppers["SamplePosition"]
        if (tray) {
            step(`moving to Position ${position}`)
            const index = (position - 1) % Math.max(tray.positions, 1)
            tray.target.setValueFromSource({ dataType: tray.current.readValue().value.dataType || DataType.UInt32, value: index })
            const arrived = () => Number(tray.current.readValue().value.value) === index && (tray.sm.getCurrentState() ?? "").includes("Stopped")
            if (!(await wait(arrived, 60000))) return undefined
        }
        // 2. injection (aspirate, move into the stream, dispense)
        if (!this.injector) return undefined
        step(`injecting ${getNumericValue(this.injector.targetValue)} µl`)
        this.injectedSample = sampleId
        this.lastChromatogram = undefined
        if (this.running(this.injector)) this.stop(this.injector, "Sample Injector stopped for the next sample")
        this.injection = undefined
        this.start(this.injector, `Sample Injector: injecting sample ${sampleId}`)
        if (!(await wait(() => !this.running(this.injector!), 120000))) {
            if (this.running(this.injector)) this.stop(this.injector, "Sample Injector stopped (run aborted)")
            return undefined
        }
        const c = this.lastChromatogram
        if (!c || c.sampleId !== sampleId) return undefined
        // 3. separation: the peaks pass the detector
        const g = composition.gradient
        step(g ? `separation, gradient ${g.from} → ${g.to} % B` : "separation")
        const done = () => {
            if (g) setB(g.from + (g.to - g.from) * Math.min(1, c.time / c.end))   // linear over the separation
            return c.finished
        }
        const ok = await wait(done, (c.end + 30) * 1000)
        if (g) setB(g.from)   // back to the start composition (re-equilibration) for the next sample
        return ok ? c : undefined
    }

    dispose() { clearInterval(this.timer); clearInterval(this.detectorTimer) }
}
