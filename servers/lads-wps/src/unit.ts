// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Water Purification System
Copyright (C) 2025  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

//---------------------------------------------------------------
// functional unit implementation
//---------------------------------------------------------------
import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSResult, LADSActiveProgram, LADSFunctionalState, LADSMultiStateDiscreteControlFunction, LADSTimerControlFunction, LADSAnalogControlFunctionWithTotalizer, LADSRunnnigState, LADSRunnnigStateMachine } from "@interfaces"
import { promoteToFiniteStateMachine, setNumericValue, touchNodes, raiseEvent, setStringValue, addProgramTemplate, modifyStatusCode, getNumericValue, installVariableHistory, noise, sleepMilliSeconds, getStringValue, LADSMaintenanceTask, MaintenanceTaskImpl, LADSMaintenanceTaskResult, setNameNodeIdValue, LADSFiniteStateMachineHelper } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantLike, SessionContext, CallMethodResultOptions, Variant, StatusCode, UAVariable, DataValue, LocalizedText, makeBrowsePath, resolveNodeId, BaseNode } from "node-opcua"
import { WpsDeviceImpl, getWpsNameSpace } from "./device"
import { WpsFunctionalUnit, WpsFunctionSet } from "./interfaces"
import { EventEmitter } from "events"
import { ComplianceDocumentReferences, ComplianceDocumentSetImpl } from "@utils"
import { join } from "path"
import { MulitStateDiscreteControlFunctionImpl, TimerControlFunctionImpl, AnalogControlFunctionWithTotalizerImpl, AnalogScalarSensorFunctionImpl } from "@utils"
import { main } from "./server"

//---------------------------------------------------------------
interface CurrentRunOptions {
    programTemplateId: string
    runId: string,
    started: Date,
    startedMilliseconds: number
    estimatedRuntime?: number
    estimatedStepNumbers?: number
    programTemplate: WpsProgramTemplate
    maintenanceTask?: MaintenanceTaskImpl
    supervisoryJobId: string
    supervisoryTaskId: string
    programTemplateNode: LADSProgramTemplate
    properties?: LADSProperty[]
    samples?: LADSSampleInfo[]
    result?: LADSResult
    // steps: WpsProgramTemplateStep[]
    runtimeInterval?: NodeJS.Timeout
}

//---------------------------------------------------------------
// program templates
//---------------------------------------------------------------
interface WpsProgramTemplate {
    name: string,
    description?: string,
    component?: string
    steps: WpsProgramTemplateStep[]
}

interface WpsProgramTemplateStep {
    name: string,
    duration?: number
    confirmation?: boolean
}

const DispenseId = "Dispense"

const ProgramTemplateDispense: WpsProgramTemplate = {
    name: DispenseId,
    description: "Dispense based on current mode and set-points",
    steps: [{ name: "Dispense", duration: 600000 }]
}

const ProgramTemplateReplaceCartridge: WpsProgramTemplate = {
    name: "Replace Cartridge",
    component: "Cartridge",
    steps: [
        { name: "Disconnect the feed-water hose from the device", confirmation: true },
        { name: "Collect the water exiting from the outlet in a container (1 L) and start depressurization.", confirmation: true },
        { name: "Depressurization 0.5 min", duration: 30000 },
        { name: "Replace cartridges according to the instructions", confirmation: true },
        { name: "Start the flushing process", confirmation: true },
        { name: "Flushing 2min", duration: 120000 },
    ]
}

const ProgramTemplateReplaceEndfilter: WpsProgramTemplate = {
    name: "Replace Endfilter",
    component: "Endfilter",
    steps: [
        { name: "Replace endfilter according to the instructions", confirmation: true },
    ]
}

const ProgramTemplateDepressurization: WpsProgramTemplate = {
    name: "Depressurization",
    steps: [
        { name: "Disconnect the feed-water hose from the device", confirmation: true },
        { name: "Collect the water exiting from the outlet in a container (1 L) and start depressurization.", confirmation: true },
        { name: "Depressurization 0.5 min", duration: 30000 },
        { name: "Switch off the device", confirmation: true },
    ]
}

const ProgramTemplateFlushTOC: WpsProgramTemplate = {
    name: "Flush TOC",
    steps: [
        { name: "Flushing 5min", duration: 300000 },
    ]
}

const ProgramTemplates: WpsProgramTemplate[] = [
    ProgramTemplateDispense,
    ProgramTemplateReplaceEndfilter,
    ProgramTemplateReplaceCartridge,
    ProgramTemplateDepressurization,
    ProgramTemplateFlushTOC,
]

export interface ProgramTemplateTuple {
    template: WpsProgramTemplate
    node: LADSProgramTemplate
}

export function findNode(parent: BaseNode, path: string[]): BaseNode {
    // copy list via slice(), otherwise teh original array will be emptied by s
    const _path = path.slice() 
    const name = _path.shift()
    if (!name) return parent
    const child = parent.getChildByName(name)
    if (!child) return undefined
    return findNode(child, _path)
}

//---------------------------------------------------------------
// specialized control functions
//---------------------------------------------------------------
class DispenseModeControlFunctionImpl extends MulitStateDiscreteControlFunctionImpl {

    constructor(controlFunction: LADSMultiStateDiscreteControlFunction) {
        super(controlFunction)
        this.targetValue?.on("value_changed", (dataValue: DataValue) => { this.currentValue.setValueFromSource(dataValue.value) })
        setNumericValue(this.targetValue, 0)
    }
}

class DispenseTimerControlFunctionImpl extends TimerControlFunctionImpl {
    dispenseController: DispenseVolumeControlFunctionImpl
    constructor(controlFuntion: LADSTimerControlFunction, dispenseController: DispenseVolumeControlFunctionImpl) {
        super(controlFuntion, true)
        setNumericValue(this.targetValue, 60.0)
        this.dispenseController = dispenseController
    }

    protected onStart(): Promise<void> {
        super.onStart()
        this.dispenseController.initComputeVolumes()
        return
    }

    evaluate(): boolean {
        const running = super.evaluate()
        if (running) this.dispenseController.computeVolumes()
        return running
    }
}

class DispenseVolumeControlFunctionImpl extends AnalogControlFunctionWithTotalizerImpl {
    flow: UAVariable
    timeBase: number
    timestamp: number

    constructor(controlFunction: LADSAnalogControlFunctionWithTotalizer, flow: UAVariable, timeBase = 60000) {
        super(controlFunction)
        setNumericValue(this.targetValue, 1.0)
        this.flow = flow
        this.timeBase = timeBase
        this.timestamp = Date.now()
    }

    protected onStart(): Promise<void> {
        this.initComputeVolumes()
        return
    }

    initComputeVolumes() {
        setNumericValue(this.currentValue, 0.0)
        this.timestamp = Date.now()
    }

    computeVolumes(): number {
        const t = Date.now()
        const dT = t - this.timestamp
        const dV = getNumericValue(this.flow) * dT / this.timeBase
        const V = getNumericValue(this.currentValue) + dV
        const Vtotal = getNumericValue(this.totalizedValue) + dV
        this.timestamp = t
        setNumericValue(this.currentValue, V)
        setNumericValue(this.totalizedValue, Vtotal)
        return V
    }

    evaluate() {
        if (this.stateMachine.currentStateNode !== this.stateRunning) return
        const V = this.computeVolumes()
        if ((getNumericValue(this.targetValue) - V) <= 0) {
            this.enterStop()
        }
    }

    protected onStop(): Promise<void> {
        this.computeVolumes()
        return
    }
}


//---------------------------------------------------------------
// unit implementation
//---------------------------------------------------------------
export class WpsUnitImpl extends EventEmitter {
    parent: WpsDeviceImpl
    functionalUnit: WpsFunctionalUnit
    functionalUnitState: UAStateMachineEx
    runningState: UAStateMachineEx
    programTemplates: ProgramTemplateTuple[] = []
    currentRunOptions: CurrentRunOptions
    documentSet: ComplianceDocumentSetImpl


    // simulator
    flow: UAVariable
    temperature: UAVariable

    // sensors
    inletConductivitySensor: AnalogScalarSensorFunctionImpl
    outletConductivitySensor: AnalogScalarSensorFunctionImpl
    temperatureSensor: AnalogScalarSensorFunctionImpl

    // controllers
    dispenseModeController: DispenseModeControlFunctionImpl
    dispenseTimeController: DispenseTimerControlFunctionImpl
    dispenseVolumeController: DispenseVolumeControlFunctionImpl


    constructor(parent: WpsDeviceImpl, optionals: string[] = []) {
        super()
        this.parent = parent
        // create unit object
        const functionalUnitSet = parent.getFunctionalUnitSet()
        const wpsUnitType = getWpsNameSpace(functionalUnitSet.addressSpace).findObjectType("WPSUnitType")
        this.functionalUnit = wpsUnitType.instantiate({
            browseName: "WPSUnit",
            displayName: "WPS Unit",
            componentOf: functionalUnitSet,
            optionals: optionals,
        }) as WpsFunctionalUnit

        // bind state machines
        const functionalUnit = this.functionalUnit
        const stateMachine = functionalUnit.functionalUnitState
        stateMachine.start?.bindMethod(this.startDispense.bind(this))
        stateMachine.startProgram?.bindMethod(this.startProgram.bind(this))
        stateMachine.stop?.bindMethod(this.stop.bind(this))
        stateMachine.abort?.bindMethod(this.abort.bind(this))
        const runningStateMachine = functionalUnit.functionalUnitState.runningStateMachine
        runningStateMachine.unhold?.bindMethod(this.resume.bind(this))
        runningStateMachine.unsuspend?.bindMethod(this.resume.bind(this))
        // promote & initialize state machines
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.currentState.on("value_changed", this.onFunctionalUnitStateChanged.bind(this))
        this.runningState = promoteToFiniteStateMachine(runningStateMachine)
        this.runningState.currentState.on("value_changed", this.onRunningStateChanged.bind(this))
        this.reset()
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
        this.deactivateRunnnigState()

        // init sensors
        const functionSet = this.functionalUnit.getComponentByName("FunctionSet") as WpsFunctionSet
        // conductivity sensors
        this.inletConductivitySensor = new AnalogScalarSensorFunctionImpl(functionSet.inletConductivity, { lowLowLimit: -0.1, lowLimit: 0.0, highLimit: 16.0, highHighLimit: 20.0 })
        this.outletConductivitySensor = new AnalogScalarSensorFunctionImpl(functionSet.outletConductivity, { lowLowLimit: -0.01, lowLimit: 0.0, highLimit: 0.16, highHighLimit: 0.2 })
        this.temperatureSensor = new AnalogScalarSensorFunctionImpl(functionSet.temperature, { lowLowLimit: 0.0, lowLimit: 10.0, highLimit: 35, highHighLimit: 40 })
        installVariableHistory(this.inletConductivitySensor.sensorValue)
        installVariableHistory(this.outletConductivitySensor.sensorValue)
        installVariableHistory(this.temperatureSensor.sensorValue)

        // add AFO
        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.purification)
        AFODictionary.addSensorFunctionReferences(this.inletConductivitySensor.sensorFunction, AFODictionaryIds.electric_conductivity)
        AFODictionary.addSensorFunctionReferences(this.outletConductivitySensor.sensorFunction, AFODictionaryIds.electric_conductivity)

        // experimental - create compliance-document-set & add fake DCC
        const device = this.parent.device
        const documentsDir = join(__dirname, "documents", device.browseName.name)
        this.documentSet = new ComplianceDocumentSetImpl(device, __dirname, documentsDir)

        // compliance documents
        // this.documentSet.load()
        if (false) {
            // add example docments from resoucres
            const dir = join(__dirname, "resources")
            const docDocument = this.documentSet.addPDFFile("EU Declaration of Conformity", new Date(), join(dir, "DoC_MS8001TS_00.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasDeclarationOfConformity }])
            AFODictionary.addReferences(docDocument, AFODictionaryIds.conformance_assessment)
            // this.documentSet.save()
        }

        // create simulation variables
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({ componentOf: functionalUnit, browseName: "Simulator" })
        this.flow = namespace.addVariable({
            browseName: "Flow",
            propertyOf: simulator,
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 1.4 }
        })
        this.temperature = namespace.addVariable({
            browseName: "Temperature",
            propertyOf: simulator,
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 25 }
        })
        this.temperature.on("value_changed", (dataValue) => setNumericValue(this.temperatureSensor.sensorValue, dataValue.value.value))

        // init program manager
        this.initProgramTemplates()
        this.initControllers(functionSet)

        // start simlulation
        const dT = 500
        let runTime = 0
        setInterval(() => {
            this.evaluate(runTime, dT)
            runTime += dT
        }, dT)
    }

    private initControllers(functionSet: WpsFunctionSet) {
        this.dispenseModeController = new DispenseModeControlFunctionImpl(functionSet.dispenseMode)
        this.dispenseVolumeController = new DispenseVolumeControlFunctionImpl(functionSet.dispenseVolume, this.flow)
        this.dispenseTimeController = new DispenseTimerControlFunctionImpl(functionSet.dispenseTime, this.dispenseVolumeController)
    }

    private evaluate(runtime: number, dT: number) {
        this.dispenseTimeController.evaluate()
        this.dispenseVolumeController.evaluate()
        const cycleTime = 60000.0
        const y = 1.0 + 0.5 * (Math.sin(2 * Math.PI * runtime / cycleTime))
        setNumericValue(this.inletConductivitySensor.sensorValue, 10.0 * (y + noise(0.05)))
        setNumericValue(this.outletConductivitySensor.sensorValue, 0.1 * (y + noise(0.05)))
        setNumericValue(this.temperatureSensor.sensorValue, getNumericValue(this.temperature) + noise(0.05))
    }

    //---------------------------------------------------------------
    // program manager implementation
    //---------------------------------------------------------------
    private initProgramTemplates() {
        const programTemplateSet = this.functionalUnit.programManager.programTemplateSet as UAObject
        // pre-initialize nodeversion to avoid node-opcua stack messages
        setStringValue(programTemplateSet.getNodeVersion(), "0")
        const date = new Date(Date.parse("2025-09-01T00:00:00.000Z"))
        ProgramTemplates.forEach(template => {
            const node = addProgramTemplate(programTemplateSet, {
                identifier: template.name,
                description: template.description,
                author: "AixEngineers",
                created: date,
                modified: date,
                referenceIds: [AFODictionaryIds.preventative_maintenance],
            }).programTemplate
            this.programTemplates.push({template: template, node: node})
        })
        touchNodes(programTemplateSet)
    }

    private readyToStart(): boolean {
        const currentState = this.functionalUnitState.getCurrentState();
        return (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted))
    }

    private readyToStop(): boolean {
        const currentState = this.functionalUnitState.getCurrentState();
        return (currentState.includes(LADSFunctionalState.Running))
    }

    private initCurrentRunOptions(programTemplateId: string): boolean {
        const id = programTemplateId.toLowerCase()
        const tuple = this.programTemplates.find(tuple => tuple.template.name.toLowerCase().includes(id))
        if (!tuple) return false
        const template = tuple.template
        const steps = template.steps
        const started = new Date()
        const iso = started.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        const deviceProgramRunId = `${date}-${time}-${this.name}-${template.name}`.replace(/[ (),°]/g, "")
        const runTime = steps.reduce((sum, step) => sum + (step.duration ? step.duration : 0), 0)
        this.currentRunOptions = {
            programTemplateId: template.name,
            started: started,
            startedMilliseconds: Date.now(),
            estimatedRuntime: runTime,
            estimatedStepNumbers: steps.length,
            programTemplate: template,
            programTemplateNode: tuple.node,
            runId: deviceProgramRunId,
            supervisoryJobId: "",
            supervisoryTaskId: "",
        }
        return true
    }

    setStatusCodes(statusCode: StatusCode) {
        modifyStatusCode(this.inletConductivitySensor.sensorValue, statusCode)
        modifyStatusCode(this.outletConductivitySensor.sensorValue, statusCode)
    }

    private get name(): string { return this.parent.config.name }

    protected async enterRunning() {
        const options = this.currentRunOptions
        raiseEvent(this.functionalUnit, `Starting method ${options.programTemplateId} with identifier ${options.runId}.`)
        // find associated maintenance task (if any)
        if (options.programTemplate.component) {
            const component = this.parent.getComponent(options.programTemplate.component)
            const maintenanceTask = component?.task
            if (maintenanceTask) {
                maintenanceTask.enterExecuting()
                options.maintenanceTask = maintenanceTask
            }
        }
        const activeProgram = this.functionalUnit.programManager.activeProgram
        setNameNodeIdValue(activeProgram.currentProgramTemplate, options.programTemplateId, options.programTemplateNode.nodeId)
        setNumericValue(activeProgram.currentRuntime, 0)
        setNumericValue(activeProgram.estimatedRuntime, options.estimatedRuntime)
        setNumericValue(activeProgram.estimatedStepNumbers, options.estimatedStepNumbers)
        setStringValue(activeProgram.deviceProgramRunId, options.runId)
        this.functionalUnitState.setState(LADSFunctionalState.Running)
        this.start()
        this.currentRunOptions = options
        this.run()
    }


    protected enterStep(step: WpsProgramTemplateStep, stepNumber: number) {
        const activeProgram = this.functionalUnit.programManager.activeProgram
        setNumericValue(activeProgram.currentStepNumber, stepNumber + 1)
        setStringValue(activeProgram.currentStepName, step.name)
        setNumericValue(activeProgram.currentStepRuntime, 0.0)
        setNumericValue(activeProgram.estimatedStepRuntime, step.duration ? step.duration : 0)
        const message = `${step.name}`
        if (step.confirmation) {
            this.hold()
            raiseEvent(this.functionalUnit, `${message} - Invoke unhold to resume`)
        } else {
            raiseEvent(this.functionalUnit, message)
        }
    }

    protected async run() {
        const options = this.currentRunOptions
        const activeProgram = this.functionalUnit.programManager.activeProgram
        const started = Date.now()
        let aborted = false
        let index = 0
        for (const step of options.programTemplate.steps) {
            if (!aborted) {
                const startedStep = Date.now()
                this.enterStep(step, index++)
                let waiting = true
                while (waiting) {
                    const now = Date.now()
                    setNumericValue(activeProgram.currentRuntime, now - started)
                    setNumericValue(activeProgram.currentStepRuntime, now - startedStep)
                    if (step.duration) {
                        waiting = (now - startedStep) < step.duration
                    } else if (step.confirmation) {
                        waiting = !this.isExecuting
                    }
                    if (this.functionalUnitState.getCurrentState().includes(LADSFunctionalState.Aborted)) {
                        this.leaveRunning(LADSFunctionalState.Aborted)
                        waiting = false
                        aborted = true
                    } else {
                        await sleepMilliSeconds(200)
                    }
                }
            }
        }
        if (!aborted) this.leaveRunning(LADSFunctionalState.Stopping)
    }

    private async leaveRunning(state: LADSFunctionalState) {
        const stateMachine = this.functionalUnitState
        stateMachine.setState(state)
        const options = this.currentRunOptions
        if (options) {
            clearInterval(options.runtimeInterval)
            this.currentRunOptions = undefined
            if (state === LADSFunctionalState.Aborting) {
                raiseEvent(this.functionalUnit, `Aborting method ${options.programTemplateId} with identifier ${options.runId}.`, 500)
                options.maintenanceTask?.enterFinished(LADSMaintenanceTaskResult.Failure, {dataType: DataType.LocalizedText, value: "Task aborted"})
            } else {
                raiseEvent(this.functionalUnit, `Finalized method ${options.programTemplateId} with identifier ${options.runId}.`, 100)
                options.maintenanceTask?.enterFinished(LADSMaintenanceTaskResult.Success)
            }
        } else {
            raiseEvent(this.functionalUnit, `Stopping method.`, 100)
        }
        this.dispenseModeController.enterStop()
        this.dispenseTimeController.enterStop()
        this.reset()
        stateMachine.setState(LADSFunctionalState.Stopped)
    }

    private async startDispense(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const mode = getNumericValue(this.dispenseModeController.currentValue)
        const controller = mode === 0 ? this.dispenseVolumeController : this.dispenseTimeController
        this.initCurrentRunOptions(DispenseId)
        // estimate runtimg
        const F = getNumericValue(this.flow) > 0 ? getNumericValue(this.flow) : 1.0
        const V = getNumericValue(this.dispenseVolumeController.targetValue)
        const T = getNumericValue(this.dispenseTimeController.targetValue)
        const estimatedRuntime = mode === 0 ? 60000 * V / F : T
        this.currentRunOptions.estimatedRuntime = estimatedRuntime
        this.enterRunning()
        controller.enterStart()
        controller.on("stop", () => this.leaveRunning(LADSFunctionalState.Stopping))
        return { statusCode: StatusCodes.Good }
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        if (programTemplateId === DispenseId) {
            return this.startDispense(inputArguments, context)
        } else if (this.initCurrentRunOptions(programTemplateId)) {
            const options = this.currentRunOptions
            options.supervisoryJobId = inputArguments[2].value ? inputArguments[2].value : ""
            options.supervisoryTaskId = inputArguments[3].value ? inputArguments[3].value : ""

            // analyze properties
            const propertiesValue = inputArguments[1].value
            options.properties = propertiesValue === null ? [] : (propertiesValue as Variant[]).map(item => { return (<any>item) as LADSProperty })

            // analyze samples
            const samplesValue = inputArguments[4].value
            options.samples = samplesValue === null ? [] : (samplesValue as Variant[]).map(item => { return (<any>item) as LADSSampleInfo })

            this.enterRunning()
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: this.currentRunOptions.runId })],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async stop(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveRunning(LADSFunctionalState.Stopping)
        return { statusCode: StatusCodes.Good }
    }

    private async abort(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveRunning(LADSFunctionalState.Aborting)
        return { statusCode: StatusCodes.Good }
    }

    // runnning state machine
    private isInRunningState(state: LADSRunnnigState): boolean { return this.runningState.getCurrentState().includes(state) }
    private get isHeld(): boolean { return this.isInRunningState(LADSRunnnigState.Held) }
    private get isSuspended(): boolean { return this.isInRunningState(LADSRunnnigState.Suspended) }
    private get isExecuting(): boolean { return this.isInRunningState(LADSRunnnigState.Execute) }

    private onFunctionalUnitStateChanged(value: DataValue) {
        const stateName: LocalizedText = value.value.value
        if (stateName.text.includes(LADSFunctionalState.Running)) {
            this.activateRunningState()
        } else {
            const lastState = this.functionalUnitState.getCurrentState()
            if (lastState) {
                if (lastState.includes(LADSFunctionalState.Running)) {
                    this.deactivateRunnnigState()
                }
            }
        }
    }

    private onRunningStateChanged(value: DataValue) {
        const stateName: LocalizedText = value.value.value
        if (value.statusCode === StatusCodes.Good) {
            setStringValue(this.functionalUnitState.currentState.effectiveDisplayName, `${LADSFunctionalState.Running}.${stateName.text}`)
        }
    }
    private activateRunningState(state = LADSRunnnigState.Execute) {
        this.runningState.setState(state)
        setStringValue(this.runningState.currentState, state, StatusCodes.Good)
    }
    private deactivateRunnnigState(state = LADSRunnnigState.Execute) {
        setStringValue(this.runningState.currentState, state, StatusCodes.BadStateNotActive)
    }

    private async transiteRunningState(fromState: LADSRunnnigState, viaState: LADSRunnnigState, toState: LADSRunnnigState, wait = 1): Promise<StatusCode> {
        if (!this.isInRunningState(fromState)) return StatusCodes.BadInvalidState
        this.runningState.setState(viaState)
        sleepMilliSeconds(wait)
        this.runningState.setState(toState)
        return StatusCodes.Good
    }
    private async start() { this.transiteRunningState(LADSRunnnigState.Idle, LADSRunnnigState.Starting, LADSRunnnigState.Execute) }
    private async hold() { this.transiteRunningState(LADSRunnnigState.Execute, LADSRunnnigState.Holding, LADSRunnnigState.Held) }
    private async unhold() { this.transiteRunningState(LADSRunnnigState.Held, LADSRunnnigState.Unholding, LADSRunnnigState.Execute) }
    private async suspend() { this.transiteRunningState(LADSRunnnigState.Execute, LADSRunnnigState.Suspending, LADSRunnnigState.Suspended) }
    private async unsuspend() { this.transiteRunningState(LADSRunnnigState.Suspended, LADSRunnnigState.Unsuspending, LADSRunnnigState.Execute) }
    private async toComplete() { this.transiteRunningState(LADSRunnnigState.Execute, LADSRunnnigState.Completing, LADSRunnnigState.Completed) }
    private async reset(wait = 1): Promise<StatusCode> { 
        this.runningState.setState(LADSRunnnigState.Resetting)
        sleepMilliSeconds(wait)
        this.runningState.setState(LADSRunnnigState.Idle)
        return StatusCodes.Good
    }

    private async resume(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (this.isHeld) {
            this.unhold()
            return { statusCode: StatusCodes.Good }
        } else if (this.isSuspended) {
            this.unsuspend()
            return { statusCode: StatusCodes.Good }
        } else {
            return { statusCode: StatusCodes.BadInvalidState }
        }
    }
}
