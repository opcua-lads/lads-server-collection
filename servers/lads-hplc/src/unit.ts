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

/** program templates of the simulated unit: identifier, description, simulated steps (name, seconds) */
export interface SimulatedProgram { identifier: string, description: string, steps: { name: string, seconds: number }[] }

export const PROGRAM_TEMPLATES: SimulatedProgram[] = [
    {
        identifier: "Isocratic Run", description: "Isocratic separation of one sample: equilibrate, inject, separate, wash.",
        steps: [{ name: "Equilibrate", seconds: 5 }, { name: "Inject", seconds: 2 }, { name: "Separate", seconds: 20 }, { name: "Wash", seconds: 5 }],
    },
    {
        identifier: "Gradient Run", description: "Gradient separation of one sample: equilibrate, inject, gradient, re-equilibrate.",
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
}

/** what runs with a program of the unit (e.g. the controllers of the simulation) */
export interface RunHooks { startControllers(): void; stopControllers(): void; anyControllerRunning(): boolean }

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
        const run: Run = { manual: false, properties, template, program, runId: createDeviceProgramRunId(template.identifier), started: new Date(), stopRequested: false }
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
        }
        raiseEvent(this.unit as unknown as UAObject, `Starting run ${run.runId} (${template.identifier}).`, EventSeverity.Info)
        this.stateMachine.setState(LADSFunctionalState.Running)
        this.hooks?.startControllers()
        this.runSteps(run)
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
        clearTimeout(run.timer)
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

    private finish(run: Run) {
        if (run.result) setDateTimeValue(run.result.stopped, new Date())
        this.hooks?.stopControllers()
        this.run = undefined
        this.stateMachine.setState(LADSFunctionalState.Stopped)
        raiseEvent(this.unit as unknown as UAObject, run.manual ? `Stopped (manual operation ${run.runId}).` : `Run ${run.runId} ${run.stopRequested ? "stopped" : "completed"}.`, EventSeverity.Info)
    }
}
