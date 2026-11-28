// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Simulated functional unit with a ProgramManager (skeleton, generic for any LADS functional unit):

  - FunctionalUnitState: Start, StartProgram, Stop, Abort, Clear are bound (those the nodeset declares); every call checks the lock (BadLocked) and the
    state (BadInvalidState): Stopped -> Running -> (Stopping) -> Stopped, Running -> Aborting -> Aborted -> Clearing -> Stopped
  - Start (manual operation, no program): Running until Stop (Stopping -> Stopped) or Abort; no result, the Properties
    argument is kept for the device driver (manualProperties); the controllers of the simulation run meanwhile
  - program templates: added at start (PROGRAM_TEMPLATES); StartProgram creates a result (ResultSet) with samples,
    properties, job / task ids and the program template, runs for the estimated runtime while ActiveProgram counts
    CurrentRuntime and the steps, then sets Stopped of the result; Abort deletes the result
  - hooks: startControllers() with the start of a run, stopControllers() when it ends, is stopped or aborted
  - manual operation by the controllers (as the viscometer): a controller started by hand sets the unit from Stopped to
    Running (refused in Aborted, Stopping ...); when the last linked controller is stopped by hand and no run is active,
    the unit goes back to Stopped; Stop / Abort of the unit in that state stop the controllers
  - IsEnabled of every function of the unit is true
  - TODO for a real instrument: replace the simulated run (runSteps) by the device driver and fill the VariableSet / FileSet
    of the result with the measured data
*/

import { CallMethodResultOptions, DataType, ISessionContext, LocalizedText, StatusCodes, UAObject, UAStateMachineEx, UAVariable, Variant, VariantLike } from "node-opcua"
import { LADSActiveProgram, LADSFunctionalState, LADSFunctionalUnit, LADSProperty, LADSResult, LADSSampleInfo } from "@interfaces"
import {
    addProgramTemplate, copyProgramTemplate, createDeviceProgramRunId, createResult, enterAborted, enterClearing, EventSeverity, FunctionalStateDelayMilliSeconds, getDescriptionVariable,
    getLADSFunctions, initNodeVersion, ProgramTemplateElement, promoteToFiniteStateMachine, raiseEvent, setBooleanValue, setDateTimeValue,
    setNumericValue, setPropertiesValue, setSamplesValue, setSessionInformation, setStringValue,
} from "@utils"
import { AccessPredicate } from "./locks"
import { Chromatogram } from "./chromatography"
import { addPeakReferences, addResultReferences } from "./afo"
import { DetectorChannel, mAU } from "./simulation"
import { makeEUInformation, Namespace } from "node-opcua"
import { EUInformation } from "node-opcua-types"
import { join } from "path"
import { DeviceInfo, LCInjection, LiquidChromatographyRecorder } from "@asm"
import { AFODictionary, AFODictionaryIds } from "@afo"

/** program templates of the simulated unit: identifier, description, simulated steps (name, seconds) */
export interface SimulatedProgram { identifier: string, description: string, steps: { name: string, seconds: number }[] }

export const PROGRAM_TEMPLATES: SimulatedProgram[] = [
    {
        identifier: "Isocratic Run", description: "Isocratic separation of the given samples, one after the other: tray position, injection, separation with constant composition. Optional property PercentageSolventB (0 … 100 %): share of solvent B for the whole run; without it the current value of the pump is kept. Per sample: SampleInfo.CustomData {\"properties\": [{\"key\": \"PercentageSolventB\", \"value\": \"40\"}]} overrides it for that sample only. Column oven: before each injection the run waits until the oven has stayed within ±ColumnOvenTolerance K of its set point (default: the High / Low limit of its AlarmMonitor, 1 K) for ColumnOvenHoldTime s (30); after ColumnOvenTimeout s (600) the run stops; WaitForColumnOven=false injects at once.",
        steps: [{ name: "Equilibrate", seconds: 5 }, { name: "Inject", seconds: 2 }, { name: "Separate", seconds: 20 }, { name: "Wash", seconds: 5 }],
    },
    {
        identifier: "Gradient Run", description: "Gradient separation of the given samples, one after the other: tray position, injection, then the share of solvent B rises linearly during the separation of each sample from GradientStart to GradientEnd and is set back to GradientStart for the next sample. Optional properties GradientStart and GradientEnd (0 … 100 %, defaults 10 and 90). Per sample: SampleInfo.CustomData {\"properties\": [{\"key\": \"GradientEnd\", \"value\": \"70\"}]} overrides them for that sample only. Column oven: before each injection the run waits until the oven has stayed within ±ColumnOvenTolerance K of its set point (default: the High / Low limit of its AlarmMonitor, 1 K) for ColumnOvenHoldTime s (30); after ColumnOvenTimeout s (600) the run stops; WaitForColumnOven=false injects at once.",
        steps: [{ name: "Equilibrate", seconds: 5 }, { name: "Inject", seconds: 2 }, { name: "Gradient", seconds: 30 }, { name: "Re-equilibrate", seconds: 8 }],
    },
]

interface Run {
    manual: boolean                     // Start without a program: runs until Stop / Abort
    properties: LADSProperty[]
    template?: ProgramTemplateElement
    program?: SimulatedProgram
    runId: string
    started: Date
    result?: LADSResult
    timer?: NodeJS.Timeout
    stopRequested: boolean
    recorder?: LiquidChromatographyRecorder   // LC ASM of the run (one injection per sample)
    perSample?: SampleSettings[]        // effective composition of each sample (run properties + its CustomData overrides)
    oven?: OvenGate                     // injection gate (column oven settled)
}

/** injection gate of a run: wait until the column oven has settled */
interface OvenGate { wait: boolean, tolerance?: number, hold: number, timeout: number }

/** WaitForColumnOven (true), ColumnOvenTolerance [K] (AlarmMonitor High / Low), ColumnOvenHoldTime [s] (30), ColumnOvenTimeout [s] (600) */
function ovenGate(properties: LADSProperty[]): { value: OvenGate, error?: string } {
    const get = (key: string) => { const p = properties.find(x => keyOf(x).toLowerCase() === key.toLowerCase()); return p === undefined ? undefined : valueOf(p).trim() }
    const num = (key: string, def: number | undefined, min: number) => {
        const v = get(key); if (v === undefined || v === "") return def
        const n = Number(v); return Number.isFinite(n) && n >= min ? n : NaN
    }
    const w = get("WaitForColumnOven")?.toLowerCase()
    if (w !== undefined && w !== "" && !["true", "false", "1", "0", "yes", "no"].includes(w)) return { value: { wait: true, hold: 30, timeout: 600 }, error: "WaitForColumnOven must be true or false" }
    const value: OvenGate = { wait: !(w === "false" || w === "0" || w === "no"), tolerance: num("ColumnOvenTolerance", undefined, 0.01),
        hold: num("ColumnOvenHoldTime", 30, 0)!, timeout: num("ColumnOvenTimeout", 600, 1)! }
    if ([value.tolerance, value.hold, value.timeout].some(x => Number.isNaN(x))) return { value, error: "ColumnOvenTolerance (> 0 K), ColumnOvenHoldTime (≥ 0 s) and ColumnOvenTimeout (≥ 1 s) must be numbers" }
    return { value }
}

/** the injection gate of one sample: waiting time, set point and tolerance */
interface OvenWait { seconds: number, target: number, tolerance: number }

/** what applies to one sample of a run */
interface SampleSettings { composition: Composition, overrides: LADSProperty[] }

/** what runs with a program of the unit (e.g. the controllers of the simulation) */
export interface RunHooks {
    startControllers(): void
    stopControllers(): void
    anyControllerRunning(): boolean
    /** one sample of a program run (HPLC: tray position, injection, chromatogram); without it the template steps are simulated */
    processSample?(sampleId: string, position: number, step: (phase: string) => void, cancelled: () => boolean, composition?: Composition): Promise<Chromatogram | undefined>
    channels?: DetectorChannel[]
    /** default tolerance of the injection gate [K] (narrow band of the oven's AlarmMonitor) */
    ovenTolerance?: number
    /** injection gate: wait until the column oven has settled */
    waitForColumnOven?(o: { tolerance: number, hold: number, timeout: number }, cancelled: () => boolean,
        progress: (current: number, target: number) => void): Promise<{ ok: boolean, waited: number, current: number, target: number, cancelled?: boolean }>
}

const SECOND = makeEUInformation("SEC", "s", "second")
const NANOMETRE = makeEUInformation("C45", "nm", "nanometre")
const MAU_S = new EUInformation({ namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact", unitId: -1, displayName: { text: "mAU·s" }, description: { text: "milli absorbance unit times second" } })
const ESTIMATED_SAMPLE_MS = 90000
const ASM_SAMPLING_RATE = 10          // [Hz] of the chromatograms in the ASM
const PEAK_DETECTION_LIMIT = 1        // [mAU] peaks lower than this at a channel are not in its ASM peak list
const RESULTS_DIRECTORY = join(__dirname, "data", "results")

/** mobile phase composition of a run: constant %B (isocratic) or a linear gradient from → to during each separation */
export interface Composition { percentB?: number, gradient?: { from: number, to: number } }

/** composition from the template and its properties (keys case-insensitive) */
function composition(template: string, properties: LADSProperty[]): { value: Composition, error?: string } {
    const prop = (key: string) => {
        const p = properties.find((x: any) => String(x?.key ?? x?.Key ?? "").toLowerCase() === key.toLowerCase()) as any
        if (p === undefined) return undefined
        const v = Number(p?.value ?? p?.Value)
        return Number.isFinite(v) && v >= 0 && v <= 100 ? v : NaN
    }
    if (/gradient/i.test(template)) {
        const from = prop("GradientStart") ?? 10, to = prop("GradientEnd") ?? 90
        if (Number.isNaN(from) || Number.isNaN(to)) return { value: {}, error: "GradientStart / GradientEnd must be numbers from 0 to 100" }
        return { value: { gradient: { from, to } } }
    }
    const b = prop("PercentageSolventB")
    if (Number.isNaN(b)) return { value: {}, error: "PercentageSolventB must be a number from 0 to 100" }
    return { value: b === undefined ? {} : { percentB: b } }
}   // per sample: position, injection, dead time, elution

/** the keys a sample may override, per template (the composition of the mobile phase) */
function sampleKeys(template: string): string[] {
    return /gradient/i.test(template) ? ["GradientStart", "GradientEnd"] : ["PercentageSolventB"]
}

const keyOf = (p: any) => String(p?.key ?? p?.Key ?? "")
const valueOf = (p: any) => String(p?.value ?? p?.Value ?? "")

/**
 * Sample specific properties from SampleInfo.CustomData: a JSON object with "properties", either a list as the run
 * properties ([{"key": "GradientEnd", "value": "70"}]) or a map ({"GradientEnd": 70}). Any other CustomData (free text,
 * JSON without "properties") is no override. They apply to this sample only, over the run properties with the same key.
 */
export function sampleOverrides(sample: LADSSampleInfo | undefined, template: string): { properties: LADSProperty[], error?: string } {
    const text = String((sample as any)?.customData ?? (sample as any)?.CustomData ?? "").trim()
    if (!text.startsWith("{")) return { properties: [] }
    let json: any
    try { json = JSON.parse(text) } catch { return { properties: [] } }
    const raw = json?.properties ?? json?.Properties
    if (raw === undefined) return { properties: [] }
    const list: any[] = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.entries(raw).map(([key, value]) => ({ key, value })) : [])
    if (!Array.isArray(raw) && (raw === null || typeof raw !== "object")) return { properties: [], error: `"properties" must be a list of {key, value} or an object` }
    const allowed = sampleKeys(template)
    const properties: LADSProperty[] = []
    for (const p of list) {
        const key = allowed.find(k => k.toLowerCase() === keyOf(p).toLowerCase())
        if (!key) return { properties: [], error: `property "${keyOf(p)}" cannot be set per sample (allowed: ${allowed.join(", ")})` }
        properties.push({ key, value: valueOf(p) } as LADSProperty)
    }
    return { properties }
}

/** the run properties with the overrides of one sample (same key, case-insensitive: the sample wins) */
function withOverrides(run: LADSProperty[], overrides: LADSProperty[]): LADSProperty[] {
    const keys = new Set(overrides.map(p => keyOf(p).toLowerCase()))
    return [...run.filter(p => !keys.has(keyOf(p).toLowerCase())), ...overrides]
}

export class SimulatedUnitImpl {
    readonly name: string
    hooks?: RunHooks
    readonly stateMachine: UAStateMachineEx
    readonly activeProgram: LADSActiveProgram
    readonly templates: ProgramTemplateElement[] = []
    private run?: Run

    constructor(readonly unit: LADSFunctionalUnit, private readonly isAccessible: AccessPredicate) {
        this.name = unit.browseName.name!
        const state = unit.functionalUnitState as any
        state.start?.bindMethod(this.start.bind(this))
        state.startProgram?.bindMethod(this.startProgram.bind(this))
        state.stop?.bindMethod(this.stop.bind(this))
        state.abort?.bindMethod(this.abort.bind(this))
        state.clear?.bindMethod(this.clear.bind(this))
        this.stateMachine = promoteToFiniteStateMachine(unit.functionalUnitState)
        this.stateMachine.setState(LADSFunctionalState.Stopped)
        this.activeProgram = unit.programManager?.activeProgram

        // every function of the unit is available
        for (const fn of getLADSFunctions(unit, true)) setBooleanValue((fn as any).isEnabled as UAVariable, true)

        // program templates
        const templateSet = unit.programManager?.programTemplateSet as unknown as UAObject
        if (templateSet) {
            initNodeVersion(templateSet)
            const date = new Date(Date.parse("2026-01-01T00:00:00.000Z"))
            for (const p of PROGRAM_TEMPLATES) {
                this.templates.push(addProgramTemplate(templateSet, { identifier: p.identifier, description: p.description, author: "AixEngineers", created: date, modified: date, referenceIds: [] }))
            }
        }
        console.log(`Unit ${this.name}: ${this.templates.length} program templates, methods ${["start", "startProgram", "stop", "abort", "clear"].filter(m => state[m]).join(", ")}`)
    }

    private get state(): string { return this.stateMachine.getCurrentState() ?? "" }

    /** a linked controller was started by hand: Stopped -> Running (manual operation); false if the unit state forbids it */
    controllerStartedByHand(controller: string): boolean {
        if (this.is(LADSFunctionalState.Stopped)) {
            this.stateMachine.setState(LADSFunctionalState.Running)
            raiseEvent(this.unit as unknown as UAObject, `Started by the ${controller}`, EventSeverity.Info)
            return true
        }
        return this.is(LADSFunctionalState.Running)
    }

    /** a linked controller was stopped by hand: without a run and with no controller left, Running -> Stopped */
    controllerStoppedByHand() {
        if (!this.run && this.is(LADSFunctionalState.Running) && !this.hooks?.anyControllerRunning()) {
            this.stateMachine.setState(LADSFunctionalState.Stopped)
            raiseEvent(this.unit as unknown as UAObject, "Stopped, all controllers are off", EventSeverity.Info)
        }
    }
    private is(state: LADSFunctionalState) { return this.state.includes(state) }

    //---------------------------------------------------------------
    // methods of the FunctionalUnitState
    //---------------------------------------------------------------
    /** Start: manual operation without a program (Properties: the only argument) */
    private async start(args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.is(LADSFunctionalState.Stopped)) return { statusCode: StatusCodes.BadInvalidState }
        const properties = ((args?.[0]?.value as Variant[] | null) ?? []).map(x => x as unknown as LADSProperty)
        const run: Run = { manual: true, properties, runId: createDeviceProgramRunId("Manual"), started: new Date(), stopRequested: false }
        this.run = run
        setStringValue(this.activeProgram?.deviceProgramRunId, run.runId)
        setNumericValue(this.activeProgram?.currentRuntime, 0)
        raiseEvent(this.unit as unknown as UAObject, `Started (manual operation${properties.length ? ", " + properties.map(p => `${p.key}=${p.value}`).join(", ") : ""}).`, EventSeverity.Info)
        this.stateMachine.setState(LADSFunctionalState.Running)
        this.hooks?.startControllers()
        const t0 = Date.now()
        const tick = () => {
            if (this.run !== run) return
            setNumericValue(this.activeProgram?.currentRuntime, Date.now() - t0)
            run.timer = setTimeout(tick, 500)
        }
        run.timer = setTimeout(tick, 500)
        return { statusCode: StatusCodes.Good }
    }

    /** the Properties of the current manual run (Start), for the device driver */
    get manualProperties(): LADSProperty[] { return this.run?.manual ? this.run.properties : [] }

    private async startProgram(args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.is(LADSFunctionalState.Stopped)) return { statusCode: StatusCodes.BadInvalidState }
        const id = String(args?.[0]?.value ?? "")
        const template = this.templates.find(t => t.identifier.toLowerCase() === id.toLowerCase())
        const program = PROGRAM_TEMPLATES.find(p => p.identifier === template?.identifier)
        if (!template || !program) return { statusCode: StatusCodes.BadInvalidArgument }

        const properties = ((args[1]?.value as Variant[] | null) ?? []).map(x => x as unknown as LADSProperty)
        const samples = ((args[4]?.value as Variant[] | null) ?? []).map(x => x as unknown as LADSSampleInfo)
        const comp = composition(template.identifier, properties)
        if (comp.error) {
            raiseEvent(this.unit as unknown as UAObject, `${template.identifier} not started: ${comp.error}`, EventSeverity.Warning)
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
        // sample specific properties (CustomData): all checked before the run starts
        const perSample: SampleSettings[] = []
        for (let i = 0; i < Math.max(1, samples.length); i++) {
            const s: any = samples[i]
            const label = String(s?.sampleId ?? s?.SampleId ?? "") || `Sample ${i + 1}`
            const o = sampleOverrides(samples[i], template.identifier)
            const c = o.error ? o : composition(template.identifier, withOverrides(properties, o.properties))
            if (c.error) {
                raiseEvent(this.unit as unknown as UAObject, `${template.identifier} not started: sample ${label}: ${c.error}`, EventSeverity.Warning)
                return { statusCode: StatusCodes.BadInvalidArgument }
            }
            perSample.push({ composition: (c as any).value, overrides: o.properties })
        }
        const gate = ovenGate(properties)
        if (gate.error) {
            raiseEvent(this.unit as unknown as UAObject, `${template.identifier} not started: ${gate.error}`, EventSeverity.Warning)
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
        const run: Run = { manual: false, properties, template, program, runId: createDeviceProgramRunId(template.identifier), started: new Date(), stopRequested: false, perSample, oven: gate.value }
        this.run = run

        // result
        const result = createResult(this.unit.programManager.resultSet as unknown as UAObject, run.runId)
        run.result = result
        if (result) {
            setSessionInformation(result, context)
            setStringValue(getDescriptionVariable(result), `Run based on template ${template.identifier}, started ${run.started.toISOString()}.`)
            setPropertiesValue(result.properties, properties)
            setSamplesValue(result.samples, samples)
            setStringValue(result.supervisoryJobId, String(args[2]?.value ?? ""))
            setStringValue(result.supervisoryTaskId, String(args[3]?.value ?? ""))
            setStringValue(result.deviceProgramRunId, run.runId)
            setDateTimeValue(result.started, run.started)
            copyProgramTemplate(template.programTemplate, result.programTemplate)
            if (this.hooks?.processSample) {
                addResultReferences(result, /gradient/i.test(template.identifier))
                run.recorder = this.createRecorder(result, samples)
            }
        }
        raiseEvent(this.unit as unknown as UAObject, `Starting run ${run.runId} (${template.identifier}).`, EventSeverity.Info)
        this.stateMachine.setState(LADSFunctionalState.Running)
        this.hooks?.startControllers()
        if (this.hooks?.processSample) this.runSamples(run, samples)
        else this.runSteps(run)
        return { statusCode: StatusCodes.Good, outputArguments: [new Variant({ dataType: DataType.String, value: run.runId })] }
    }

    private async stop(_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.is(LADSFunctionalState.Running)) return { statusCode: StatusCodes.BadInvalidState }
        if (!this.run) {                // running by the controllers only: stop them, Stopping -> Stopped
            this.hooks?.stopControllers()
            this.stateMachine.setState(LADSFunctionalState.Stopping)
            setTimeout(() => {
                this.stateMachine.setState(LADSFunctionalState.Stopped)
                raiseEvent(this.unit as unknown as UAObject, "Stopped, controllers off", EventSeverity.Info)
            }, FunctionalStateDelayMilliSeconds)
            return { statusCode: StatusCodes.Good }
        }
        this.run.stopRequested = true   // a program ends after the current step (Stopping)
        this.stateMachine.setState(LADSFunctionalState.Stopping)
        if (this.run.manual) {          // manual operation: Stopping -> Stopped after a short delay
            const run = this.run
            clearTimeout(run.timer)
            setTimeout(() => this.finish(run), FunctionalStateDelayMilliSeconds)
        }
        return { statusCode: StatusCodes.Good }
    }

    private async abort(_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!(this.is(LADSFunctionalState.Running) || this.is(LADSFunctionalState.Stopping))) return { statusCode: StatusCodes.BadInvalidState }
        if (!this.run) {                // running by the controllers only
            this.hooks?.stopControllers()
            this.stateMachine.setState(LADSFunctionalState.Aborting)
            enterAborted(this.stateMachine, this.unit as unknown as UAObject, "Aborted, controllers off.")
            return { statusCode: StatusCodes.Good }
        }
        const run = this.run
        clearTimeout(run.timer); clearInterval(run.timer)
        this.run = undefined
        if (run.result) run.result.namespace.deleteNode(run.result as unknown as UAObject)
        this.hooks?.stopControllers()
        this.stateMachine.setState(LADSFunctionalState.Aborting)
        enterAborted(this.stateMachine, this.unit as unknown as UAObject, `Aborted run ${run.runId}.`)   // Aborting -> Aborted
        return { statusCode: StatusCodes.Good }
    }

    private async clear(_args: VariantLike[], context: ISessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessible(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.is(LADSFunctionalState.Aborted)) return { statusCode: StatusCodes.BadInvalidState }
        enterClearing(this.stateMachine, this.unit as unknown as UAObject)   // Aborted -> Clearing -> Stopped
        return { statusCode: StatusCodes.Good }
    }

    //---------------------------------------------------------------
    // simulated run (TODO: device driver)
    //---------------------------------------------------------------
    private runSteps(run: Run) {
        const ap = this.activeProgram
        const steps = run.program.steps
        const total = steps.reduce((s, x) => s + x.seconds, 0) * 1000
        setNumericValue(ap?.estimatedRuntime, total)
        setNumericValue(ap?.estimatedStepNumbers, steps.length)
        setStringValue(ap?.deviceProgramRunId, run.runId)
        const t0 = Date.now()
        let index = 0, stepStart = t0
        const enterStep = () => {
            const step = steps[index]
            stepStart = Date.now()
            setNumericValue(ap?.currentStepNumber, index + 1)
            ap?.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: new LocalizedText({ text: step.name }) })
            setNumericValue(ap?.estimatedStepRuntime, step.seconds * 1000)
            raiseEvent(this.unit as unknown as UAObject, `Run ${run.runId}: step ${index + 1}/${steps.length} ${step.name}.`, EventSeverity.Info)
        }
        enterStep()
        const tick = () => {
            if (this.run !== run) return   // aborted
            const now = Date.now()
            setNumericValue(ap?.currentRuntime, now - t0)
            setNumericValue(ap?.currentStepRuntime, now - stepStart)
            if (now - stepStart >= steps[index].seconds * 1000) {
                index++
                if (index >= steps.length || run.stopRequested) return this.finish(run)
                enterStep()
            }
            run.timer = setTimeout(tick, 500)
        }
        run.timer = setTimeout(tick, 500)
    }

    /**
     * HPLC program run: the samples one after the other (tray position = index in the list, 1 …), each injected and
     * measured; the peaks of every sample go into the VariableSet of the result. Stop: after the current sample.
     */
    private async runSamples(run: Run, samples: LADSSampleInfo[]) {
        const unit = this.unit as unknown as UAObject
        const ap = this.activeProgram
        const ids = samples.map((x: any, i) => String(x?.sampleId ?? x?.SampleId ?? "") || `Sample ${i + 1}`)
        if (ids.length === 0) ids.push("Sample 1")
        setStringValue(ap?.deviceProgramRunId, run.runId)
        setNumericValue(ap?.estimatedStepNumbers, ids.length)
        setNumericValue(ap?.estimatedRuntime, ids.length * ESTIMATED_SAMPLE_MS)
        setNumericValue(ap?.estimatedStepRuntime, ESTIMATED_SAMPLE_MS)
        const t0 = Date.now()
        let stepStart = t0
        run.timer = setInterval(() => {
            setNumericValue(ap?.currentRuntime, Date.now() - t0)
            setNumericValue(ap?.currentStepRuntime, Date.now() - stepStart)
        }, 500)
        for (let i = 0; i < ids.length; i++) {
            if (this.run !== run) return                 // aborted
            if (run.stopRequested) break
            const id = ids[i]
            stepStart = Date.now()
            setNumericValue(ap?.currentStepNumber, i + 1)
            const settings = run.perSample?.[i] ?? { composition: composition(run.template?.identifier ?? "", run.properties).value, overrides: [] }
            const own = settings.overrides.length ? `, ${settings.overrides.map(p => `${keyOf(p)}=${valueOf(p)}`).join(", ")} (sample)` : ""
            raiseEvent(unit, `Processing sample ${id} (${i + 1} of ${ids.length}${own})`, EventSeverity.Info)
            const step = (phase: string) => ap?.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: new LocalizedText({ text: `Sample ${id}: ${phase}` }) })
            // injection gate: the column oven must have settled
            let ovenWait: OvenWait | undefined
            if (run.oven?.wait && this.hooks?.waitForColumnOven) {
                const tolerance = run.oven.tolerance ?? this.hooks.ovenTolerance ?? 1
                const r = await this.hooks.waitForColumnOven({ tolerance, hold: run.oven.hold, timeout: run.oven.timeout }, () => this.run !== run || run.stopRequested,
                    (cur, target) => step(`waiting for column oven (${cur.toFixed(1)} → ${target.toFixed(1)} °C, ±${tolerance} K)`))
                if (this.run !== run) return
                if (run.stopRequested) break
                if (!r.ok) {
                    raiseEvent(unit, `Run ${run.runId}: column oven not settled within ${run.oven.timeout} s (${r.current.toFixed(1)} °C, set point ${r.target.toFixed(1)} °C ±${tolerance} K): run stopped before sample ${id}`, EventSeverity.Warning)
                    break
                }
                if (r.waited >= 1) raiseEvent(unit, `Sample ${id}: column oven settled at ${r.current.toFixed(1)} °C (set point ${r.target.toFixed(1)} °C ±${tolerance} K) after ${Math.round(r.waited)} s`, EventSeverity.Info)
                ovenWait = { seconds: r.waited, target: r.target, tolerance }
            }
            const chromatogram = await this.hooks!.processSample!(id, i + 1, step, () => this.run !== run, settings.composition)
            if (this.run !== run) return
            if (chromatogram && run.result) {
                this.addPeaks(run.result, id, chromatogram)
                run.recorder?.addInjection(this.lcInjection(samples[i], id, i + 1, chromatogram, settings.composition, ovenWait))
            }
            else raiseEvent(unit, `Sample ${id}: no chromatogram recorded`, EventSeverity.Warning)
        }
        clearInterval(run.timer)
        await this.writeASM(run)
        if (this.run !== run) return
        this.finish(run)
    }

    //---------------------------------------------------------------
    // Allotrope Simple Model (liquid chromatography) of a program run
    //---------------------------------------------------------------
    /** the device of the unit (Device/FunctionalUnitSet/<unit>) and its modules for the device documents */
    private createRecorder(result: LADSResult, samples: LADSSampleInfo[]): LiquidChromatographyRecorder | undefined {
        try {
            const device = ((this.unit as unknown as UAObject).parent as any)?.parent as UAObject
            const components = device?.getChildByName("Components") as UAObject | null
            const module = (name: string, deviceType: string): DeviceInfo | undefined => {
                const c = components?.getChildByName(name)
                return c ? { device: c as any, deviceType } : undefined
            }
            const pump = module("Pump", "pump"), detector = module("DAD", "diode array detector")
            const modules = [module("AutoSampler", "autosampler"), pump, module("ColumnCompartment", "column compartment"), detector].filter(Boolean) as DeviceInfo[]
            const empty = { sampleId: "", containerId: "", position: "", customData: "" } as LADSSampleInfo
            return new LiquidChromatographyRecorder({
                result, sample: samples[0] ?? empty, pump, detector,
                devices: [{ device: device as any, deviceType: "liquid chromatograph" }, ...modules],
            })
        } catch (err) {
            console.warn(`Unit ${this.name}: no ASM recorder (${err})`)
            return undefined
        }
    }

    /** one injection: every detector channel with its chromatogram and peaks at the channel wavelength */
    private lcInjection(sample: LADSSampleInfo | undefined, sampleId: string, position: number, c: Chromatogram, comp: Composition = {}, oven?: OvenWait): LCInjection {
        const s: any = sample ?? {}
        const info = { sampleId: String(s.sampleId ?? s.SampleId ?? "") || sampleId, containerId: String(s.containerId ?? s.ContainerId ?? ""),
            position: String(s.position ?? s.Position ?? "") || `Position ${position}`, customData: String(s.customData ?? s.CustomData ?? "") } as LADSSampleInfo
        const device = ((this.unit as unknown as UAObject).parent as any)?.parent as UAObject
        const column = (device?.getChildByName("Components") as UAObject | null)?.getChildByName("ColumnCompartment")
        const column1 = (column?.getChildByName("Components") as UAObject | null)?.getChildByName("Column1") as any
        const model = column1?.model?.readValue()?.value?.value?.text ?? ""
        const conditions: LCInjection["conditions"] = [{ label: "flow rate", value: c.flow, unit: "mL/min" }]
        if (c.columnTemperature !== undefined) conditions.push({ label: "column temperature", value: c.columnTemperature, unit: "degC" })
        if (oven) conditions.push({ label: "column temperature setting", value: oven.target, unit: "degC" },
            { label: "column temperature tolerance", value: oven.tolerance, unit: "K" }, { label: "column oven waiting time", value: oven.seconds, unit: "s" })
        if (c.percentB !== undefined) conditions.push({ label: "solvent B", value: c.percentB, unit: "%" })
        if (comp.gradient) conditions.push({ label: "gradient start", value: comp.gradient.from, unit: "%" }, { label: "gradient end", value: comp.gradient.to, unit: "%" })
        conditions.push({ label: "dead time", value: c.deadTime, unit: "s" })
        return {
            sample: info,
            injectionIdentifier: `Injection ${position}`,
            injectionTime: new Date(c.injected),
            injectionVolume: c.injectionVolume ?? 0,
            column: column1 ? {
                name: model || column1.getDisplayName(),
                manufacturer: column1.manufacturer?.readValue()?.value?.value?.text,
                serialNumber: column1.serialNumber?.readValue()?.value?.value,
                chemistry: /\b(C18|C8|C4|phenyl|HILIC|CN|NH2)\b/i.exec(model)?.[1],
            } : undefined,
            conditions,
            channels: (this.hooks?.channels ?? []).map(ch => {
                const trace = c.trace(ch.wavelength, ASM_SAMPLING_RATE)
                return {
                    identifier: ch.name, wavelength: ch.wavelength, samplingRate: ASM_SAMPLING_RATE,
                    retentionTimes: trace.times, absorbances: trace.values,
                    peaks: c.peaks.map(p => ({ p, v: Chromatogram.evaluate(p, ch.wavelength) })).filter(x => x.v.height >= PEAK_DETECTION_LIMIT).map(({ p, v }) => ({
                        retentionTime: v.retentionTime, height: v.height, area: v.area, widthAtHalfHeight: v.width,
                        start: Math.max(0, p.retentionTime - 4 * p.halfWidth), end: Math.min(c.end, p.retentionTime + 4 * p.halfWidth),
                    })),
                }
            }),
        }
    }

    /** FileSet/ASM (<run id>.json in data/results) and VariableSet/ASM (the same JSON as a string) */
    private async writeASM(run: Run) {
        const result = run.result, recorder = run.recorder
        if (!result || !recorder || recorder.injections.length === 0) return
        try {
            const model = recorder.createModel()
            await recorder.writeResultFile(result.fileSet as unknown as UAObject, "ASM", RESULTS_DIRECTORY, run.runId, model)
            if (result.variableSet) {
                const asm = result.namespace.addVariable({
                    propertyOf: result.variableSet, browseName: "ASM", dataType: DataType.String,
                    description: "Allotrope Simple Model (liquid chromatography, REC/2026/09) of the run: one LC document per injection, one measurement document per detector channel",
                    value: { dataType: DataType.String, value: JSON.stringify(model, null, 2) },
                })
                AFODictionary.addReferences(asm, AFODictionaryIds.ASM_file, AFODictionaryIds.liquid_chromatography_aggregate_document, AFODictionaryIds.chromatogram, AFODictionaryIds.peak_list)
            }
            raiseEvent(this.unit as unknown as UAObject, `Run ${run.runId}: ASM written (${recorder.injections.length} injections)`, EventSeverity.Info)
        } catch (err) {
            console.warn(`Run ${run.runId}: ASM not written (${err})`)
            raiseEvent(this.unit as unknown as UAObject, `Run ${run.runId}: ASM not written (${err})`, EventSeverity.Warning)
        }
    }

    /** VariableSet / <sample> / Peak n / Retention Time, Height, Width, Area (at the DAD channel with the strongest signal), Channel, Absorption Maximum */
    private addPeaks(result: LADSResult, sampleId: string, c: Chromatogram) {
        const variableSet = result.variableSet
        if (!variableSet) return
        const ns = variableSet.namespace as Namespace
        const channels = this.hooks?.channels ?? []
        const sample = ns.addObject({ componentOf: variableSet, browseName: sampleId.replace(/[^A-Za-z0-9_-]/g, "_"), displayName: sampleId,
            description: `Peaks of sample ${sampleId}: dead time ${c.deadTime.toFixed(1)} s` })
        const add = (parent: UAObject, name: string, value: number, eu: any) => ns.addAnalogDataItem({
            componentOf: parent, browseName: name.replace(/ /g, ""), displayName: name, dataType: "Double",
            engineeringUnits: eu, engineeringUnitsRange: { low: 0, high: Math.max(1, value * 2) },
            value: { dataType: DataType.Double, value },
        })
        const peakObjects: UAObject[] = []
        c.peaks.forEach((p, k) => {
            const best = channels.reduce((b, ch) => Chromatogram.band(p, ch.wavelength) > Chromatogram.band(p, b.wavelength) ? ch : b, channels[0])
            const v = Chromatogram.evaluate(p, best ? best.wavelength : p.wavelength)
            const peak = ns.addObject({ componentOf: sample, browseName: `Peak${k + 1}`, displayName: `Peak ${k + 1}` })
            peakObjects.push(peak)
            add(peak, "Retention Time", +v.retentionTime.toFixed(3), SECOND)
            add(peak, "Height", +v.height.toFixed(3), mAU)
            add(peak, "Width", +v.width.toFixed(3), SECOND)
            add(peak, "Area", +v.area.toFixed(3), MAU_S)
            add(peak, "Absorption Maximum", +p.wavelength.toFixed(1), NANOMETRE)
            ns.addVariable({ componentOf: peak, browseName: "Channel", dataType: DataType.String,
                value: { dataType: DataType.String, value: best ? `${best.name} (${best.wavelength} nm)` : "" } })
        })
        addPeakReferences(sample, peakObjects)
        raiseEvent(this.unit as unknown as UAObject, `Sample ${sampleId}: ${c.peaks.length} peaks recorded`, EventSeverity.Info)
    }

    private finish(run: Run) {
        if (run.result) setDateTimeValue(run.result.stopped, new Date())
        this.hooks?.stopControllers()
        this.run = undefined
        this.stateMachine.setState(LADSFunctionalState.Stopped)
        raiseEvent(this.unit as unknown as UAObject, run.manual ? `Stopped (manual operation ${run.runId}).` : `Run ${run.runId} ${run.stopRequested ? "stopped" : "completed"}.`, EventSeverity.Info)
    }
}
