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
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSResult, LADSActiveProgram, LADSFunctionalState, LADSAnalogScalarSensorFunction, LADSMultiStateDiscreteControlFunction, LADSTimerControlFunction, LADSAnalogControlFunctionWithTotalizer, LADSBaseControlFunction, LADSAnalogControlFunction } from "@interfaces"
import { getLADSObjectType, getDescriptionVariable, promoteToFiniteStateMachine, setNumericValue, touchNodes, raiseEvent, setStringValue, setDateTimeValue, copyProgramTemplate, setPropertiesValue, setSamplesValue, setSessionInformation, ProgramTemplateElement, addProgramTemplate, modifyStatusCode, getNumericValue } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantLike, SessionContext, CallMethodResultOptions, Variant, StatusCode, UAAnalogUnitRange, UAVariable, UAState, UAMultiStateDiscrete, DataValue } from "node-opcua"
import { WpsDeviceImpl, getWpsNameSpace } from "./device"
import { ConductivitySensor, WpsFunctionalUnit, WpsFunctionalUnitStatemachine, WpsFunctionSet } from "./interfaces"
import { EventEmitter } from "events"
import { ComplianceDocumentReferences, ComplianceDocumentSetImpl } from "utils/src/lads-cd"
import { join } from "path"

//---------------------------------------------------------------
interface CurrentRunOptions {
    programTemplateId: string
    runId: string,
    started: Date,
    startedMilliseconds: number
    estimatedRuntimeMilliseconds: number
    programTemplate: LADSProgramTemplate
    supervisoryJobId: string
    supervisoryTaskId: string
    properties?: LADSProperty[]
    samples?: LADSSampleInfo[]
    result?: LADSResult
    steps: WpsProgramTemplateStep[]
    runtimeInterval?: NodeJS.Timeout
}

interface WpsProgramTemplate {
    name: string,
    description?: string,
    steps: WpsProgramTemplateStep[]
}

interface WpsProgramTemplateStep {
    name: string,
    duration: number
}

const ProgramTemplates: WpsProgramTemplate[] = [
    {
        name: "Dispense",
        description: "Dispense based on current mode and set-points",
        steps: [{ name: "Dispense", duration: 600000 }]
    },
    {
        name: "Sanitize",
        description: "Perform system sanitization",
        steps: [{ name: "Prepare", duration: 5000 }]
    }
]

function installVariableHistory(variable: UAVariable) {
    if (!variable) return
    variable.historizing = true
    variable.addressSpace.installHistoricalDataNode(variable)
}

function noise(amplitude: number) { return amplitude * (Math.random() - 0.5) }


interface ControlFunctionEvents {
    "start": []
    "stop": []
}

export class ControlFunctionImpl extends EventEmitter<ControlFunctionEvents> {
    contolFunction: LADSBaseControlFunction
    stateMachine: UAStateMachineEx
    stateRunning: UAState
    stateStopped: UAState

    constructor(controlFunction: LADSBaseControlFunction) {
        super()
        this.contolFunction = controlFunction
        this.stateMachine = promoteToFiniteStateMachine(controlFunction.controlFunctionState)
        this.stateRunning = this.stateMachine.getStateByName(LADSFunctionalState.Running)
        this.stateStopped = this.stateMachine.getStateByName(LADSFunctionalState.Stopped)
        controlFunction.controlFunctionState.start?.bindMethod(this.handleStart.bind(this))
        controlFunction.controlFunctionState.stop?.bindMethod(this.handleStop.bind(this))
    }

    private async handleStart(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.enterStart()
        return { statusCode: StatusCodes.Good }
    }
    async enterStart() {
        this.stateMachine.setState(LADSFunctionalState.Running)
        this.emit("start")
        this.onStart()
    }
    protected async onStart() { }

    private async handleStop(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.enterStop()
        return { statusCode: StatusCodes.Good }
    }
    async enterStop() {
        this.onStop()
        this.emit("stop")
        this.stateMachine.setState(LADSFunctionalState.Stopped)
    }
    protected async onStop() { }
}

export class MulitStateDiscreteControlFunctionImpl extends ControlFunctionImpl {
    targetValue: UAMultiStateDiscrete<number, DataType.UInt32>
    currentValue: UAMultiStateDiscrete<number, DataType.UInt32>

    constructor(controlFunction: LADSMultiStateDiscreteControlFunction) {
        super(controlFunction)
        this.targetValue = controlFunction.targetValue
        this.currentValue = controlFunction.currentValue
    }
}

export class AnalogControlFunctionImpl extends ControlFunctionImpl {
    targetValue: UAAnalogUnitRange<number, DataType.Double>
    currentValue: UAAnalogUnitRange<number, DataType.Double>

    constructor(controlFunction: LADSAnalogControlFunction) {
        super(controlFunction)
        this.targetValue = controlFunction.targetValue
        this.currentValue = controlFunction.currentValue
    }
}
export class AnalogControlFunctionWithTotalizerImpl extends AnalogControlFunctionImpl {
    totalizedValue: UAAnalogUnitRange<number, DataType.Double>

    constructor(controlFunction: LADSAnalogControlFunctionWithTotalizer) {
        super(controlFunction)
        this.totalizedValue = controlFunction.totalizedValue
        controlFunction.resetTotalizer?.bindMethod(this.handleResetTotalizer.bind(this))
    }

    private async handleResetTotalizer(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        const value = inputArguments.length > 0 ? Number(inputArguments[0]) : 0
        setNumericValue(this.totalizedValue, value)
        return { statusCode: StatusCodes.Good }
    }
}

export class TimerControlFunctionImpl extends AnalogControlFunctionImpl {
    started: number
    autoStop: boolean = false
    differenceValue: UAAnalogUnitRange<number, DataType.Double>

    constructor(controlFunction: LADSTimerControlFunction, autoStop = false) {
        super(controlFunction)
        this.started = Date.now()
        this.autoStop = autoStop
        this.differenceValue = controlFunction.differenceValue
        this.targetValue?.on("value_changed", (dataValue) => { this.updateDifferenceValue() })
        this.currentValue?.on("value_changed", (dataValue) => { this.updateDifferenceValue() })
    }

    private updateDifferenceValue() {
        if (!this.targetValue) return
        if (!this.currentValue) return
        if (!this.differenceValue) return
        setNumericValue(this.differenceValue, getNumericValue(this.targetValue) - getNumericValue(this.currentValue))
    }

    private updateCurrentValue() { setNumericValue(this.currentValue, Date.now() - this.started) }

    protected onStart(): Promise<void> {
        setNumericValue(this.currentValue, 0.0)
        this.started = Date.now()
        return
    }

    evaluate(): boolean {
        if (this.stateMachine.currentStateNode !== this.stateRunning) return false
        this.updateCurrentValue()
        if (this.autoStop && this.targetValue && this.currentValue) {
            const dt = getNumericValue(this.targetValue) - getNumericValue(this.currentValue)
            if (dt <= 0) {
                this.enterStop()
            }
        }
        return true
    }

    protected onStop(): Promise<void> {
        this.updateCurrentValue()
        return
    }
}

class DispenseModeControlFunctionImpl extends MulitStateDiscreteControlFunctionImpl {

    constructor(controlFunction: LADSMultiStateDiscreteControlFunction) {
        super(controlFunction)
        this.targetValue?.on("value_changed", (dataValue: DataValue) => { this.currentValue.setValueFromSource(dataValue.value) })
    }
}

class DispenseTimerControlFunctionImpl extends TimerControlFunctionImpl {
    dispenseController: DispenseVolumeControlFunctionImpl
    constructor(controlFuntion: LADSTimerControlFunction, dispenseController: DispenseVolumeControlFunctionImpl) {
        super(controlFuntion, true)
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
export class WpsUnitImpl extends EventEmitter {
    parent: WpsDeviceImpl
    functionalUnit: WpsFunctionalUnit
    functionalUnitState: UAStateMachineEx
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    currentRunOptions: CurrentRunOptions
    programTemplateElements: ProgramTemplateElement[] = []
    documentSet: ComplianceDocumentSetImpl

    // simulator
    flow: UAVariable

    // sensors
    inletConductivitySensor: ConductivitySensor
    outletConductivitySensor: ConductivitySensor
    temperatureSensor: LADSAnalogScalarSensorFunction

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
            optionals: optionals
        }) as WpsFunctionalUnit
        // this.functionalUnit = parent.getFunctionalUnit()

        // init functional unit & state machine
        const functionalUnit = this.functionalUnit
        const stateMachine = functionalUnit.functionalUnitState as WpsFunctionalUnitStatemachine
        stateMachine.start?.bindMethod(this.start.bind(this))
        stateMachine.startProgram?.bindMethod(this.startProgram.bind(this))
        stateMachine.stop?.bindMethod(this.stop.bind(this))
        stateMachine.abort?.bindMethod(this.abort.bind(this))
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)

        // init sensors
        const functionSet = this.functionalUnit.getComponentByName("FunctionSet") as WpsFunctionSet
        // conductivity sensors
        this.inletConductivitySensor = functionSet.inletConductivity
        this.outletConductivitySensor = functionSet.outletConductivity
        this.temperatureSensor = functionSet.temperature
        installVariableHistory(this.inletConductivitySensor.sensorValue)
        installVariableHistory(this.outletConductivitySensor.sensorValue)
        installVariableHistory(this.temperatureSensor.sensorValue)

        // add AFO
        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.purification)
        AFODictionary.addSensorFunctionReferences(this.inletConductivitySensor, AFODictionaryIds.electric_conductivity)
        AFODictionary.addSensorFunctionReferences(this.outletConductivitySensor, AFODictionaryIds.electric_conductivity)

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
        const y = 0.5 * (1 + Math.sin(2 * Math.PI * runtime / cycleTime))
        setNumericValue(this.inletConductivitySensor.sensorValue, 10.0 * (y + noise(0.05)))
        setNumericValue(this.outletConductivitySensor.sensorValue, 0.1 * (y + noise(0.05)))
        setNumericValue(this.temperatureSensor.sensorValue, 25 + noise(0.05))
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
            this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
                identifier: template.name,
                description: template.description,
                author: "AixEngineers",
                created: date,
                modified: date,
                referenceIds: [AFODictionaryIds.preventative_maintenance],
            }))
        })
        touchNodes(programTemplateSet)
    }

    private touchResult() {
        const result = this.currentRunOptions.result
        touchNodes(this.functionalUnit.programManager.resultSet as UAObject, result, result?.fileSet, result?.variableSet)
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
        const element = this.findProgramTemplateElement(programTemplateId)
        if (!element) return false
        const steps = ProgramTemplates.find(template => (template.name == element.identifier)).steps
        const started = new Date()
        const iso = started.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        const deviceProgramRunId = `${date}-${time}-${this.name}-${element.identifier}`.replace(/[ (),°]/g, "")
        const runTime = steps.reduce((sum, step) => sum + step.duration, 0)
        this.currentRunOptions = {
            programTemplateId: element.identifier,
            started: started,
            startedMilliseconds: Date.now(),
            estimatedRuntimeMilliseconds: runTime,
            programTemplate: element.programTemplate,
            runId: deviceProgramRunId,
            supervisoryJobId: "",
            supervisoryTaskId: "",
            steps: steps,
        }
        return true
    }

    setStatusCodes(statusCode: StatusCode) {
        modifyStatusCode(this.inletConductivitySensor.sensorValue, statusCode)
        modifyStatusCode(this.outletConductivitySensor.sensorValue, statusCode)
    }

    private get name(): string { return this.parent.config.name }

    private raiseMessage(message: string, severity = 0) {
        console.info(message)
        raiseEvent(this.functionalUnit, message, severity)
    }

    protected async enterRunning() {
        const options = this.currentRunOptions
        raiseEvent(this.functionalUnit, `Starting method ${options.programTemplateId} with identifier ${options.runId}.`)
        const activeProgram = this.functionalUnit.programManager.activeProgram
        setNumericValue(activeProgram.currentRuntime, 0)
        setNumericValue(activeProgram.estimatedRuntime, options.estimatedRuntimeMilliseconds)
        setStringValue(activeProgram.deviceProgramRunId, options.runId)
        // run loop
        const dT = 500
        options.runtimeInterval = setInterval(() => {
            const runtime = Date.now() - options.startedMilliseconds
            setNumericValue(activeProgram.currentRuntime, runtime)
            if (runtime > options.estimatedRuntimeMilliseconds) {
                this.leaveRunning(LADSFunctionalState.Aborting)
            }
        }, dT)
        this.functionalUnitState.setState(LADSFunctionalState.Running)
        this.currentRunOptions = options
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
            } else {
                raiseEvent(this.functionalUnit, `Finalized method ${options.programTemplateId} with identifier ${options.runId}.`, 100)
            }
        } else {
            raiseEvent(this.functionalUnit, `Stopping method.`, 100)
        }
        stateMachine.setState(LADSFunctionalState.Stopped)
    }


    protected async enterMeasuring(context: SessionContext) {
        const options = this.currentRunOptions
        const programTemplateId = options.programTemplateId
        raiseEvent(this.functionalUnit, `Starting method ${programTemplateId} with identifier ${options.runId}.`)

        // create result
        const createResult = false
        if (createResult) {
            const referenceIds: string[] = [AFODictionaryIds.purification, AFODictionaryIds.document]
            const resultType = getLADSObjectType(this.functionalUnit.addressSpace, "ResultType")
            const resultSet = <UAObject>this.functionalUnit.programManager.resultSet
            options.result = <LADSResult><unknown>resultType.instantiate({
                componentOf: resultSet,
                browseName: options.runId,
                optionals: ["NodeVersion", "FileSet.NodeVersion", "VariableSet.NodeVersion"]
            })
            const result = options.result
            AFODictionary.addDefaultResultReferences(result)
            AFODictionary.addReferences(result, ...referenceIds)

            setSessionInformation(result, context)
            setStringValue(getDescriptionVariable(result), `Run based on template ${options.programTemplateId}, started ${options.started.toLocaleDateString()}.`)
            setPropertiesValue(result.properties, options.properties)
            setSamplesValue(result.samples, options.samples)
            setStringValue(result.supervisoryJobId, options.supervisoryJobId)
            setStringValue(result.supervisoryTaskId, options.supervisoryTaskId)
            setStringValue(result.deviceProgramRunId, options.runId)
            setDateTimeValue(result.started, options.started)
            copyProgramTemplate(options.programTemplate, result.programTemplate)
            this.touchResult()

        }

    }

    private async leaveMeasuring() {
        const result = this.currentRunOptions?.result
        if (result) {
            // set stopped timestamp
            setDateTimeValue(result.stopped, new Date())

            // add results
            this.touchResult()
        }
    }

    private findProgramTemplateElement(programTemplateId: string): ProgramTemplateElement {
        const id = programTemplateId.toLowerCase()
        return this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(id))
    }

    private async startMethod(context: SessionContext, programTemplateId: string, properties?: LADSProperty[], samples?: LADSSampleInfo[]): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        this.initCurrentRunOptions(programTemplateId)
        this.currentRunOptions.properties = properties ?? []
        this.currentRunOptions.samples = samples ?? []
        this.enterMeasuring(context)
        return { statusCode: StatusCodes.Good }
    }

    private async start(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const mode = getNumericValue(this.dispenseModeController.currentValue)
        const controller = mode === 0 ? this.dispenseVolumeController : this.dispenseTimeController
        this.initCurrentRunOptions("Dispense")
        // estimate runtimg
        const F = getNumericValue(this.flow) > 0 ? getNumericValue(this.flow) : 1.0
        const V = getNumericValue(this.dispenseVolumeController.targetValue)
        const T = getNumericValue(this.dispenseTimeController.targetValue)
        const estimatedRuntime = mode === 0 ? 60000 * V / F : T
        this.currentRunOptions.estimatedRuntimeMilliseconds = estimatedRuntime
        this.enterRunning()
        controller.enterStart()
        controller.on("stop", () => this.leaveRunning(LADSFunctionalState.Stopping))
        return { statusCode: StatusCodes.Good }

        // search key-value pairs for sampleId
        /*const inputArgument = inputArguments[0].value
        const keyValuePairs = (inputArgument === null) ? [] : (inputArgument as Variant[]).map(item => { return (<any>item) as DTKeyValuePair })
        const sampleKeyValuePair = keyValuePairs.find(keyValuePair => (keyValuePair.key.name.toLowerCase().includes("sampleid")))
        const sampleId: string = sampleKeyValuePair ? String(sampleKeyValuePair.value.value) : "Unknown"
        const sampleInfo: LADSSampleInfo = { containerId: "", sampleId: sampleId, position: "", customData: "" }*/
        //return await this.startMethod(context, ProgramTemplateIds.RegisterWeight, undefined, [sampleInfo])
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        if (this.initCurrentRunOptions(programTemplateId)) {
            this.runProgram(inputArguments, context)
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: this.currentRunOptions.runId })],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async runProgram(inputArguments: VariantLike[], context: SessionContext) {
        const options = this.currentRunOptions
        options.supervisoryJobId = inputArguments[2].value ? inputArguments[2].value : ""
        options.supervisoryTaskId = inputArguments[3].value ? inputArguments[3].value : ""

        // analyze properties
        const propertiesValue = inputArguments[1].value
        options.properties = propertiesValue === null ? [] : (propertiesValue as Variant[]).map(item => { return (<any>item) as LADSProperty })

        // analyze samples
        const samplesValue = inputArguments[4].value
        options.samples = samplesValue === null ? [] : (samplesValue as Variant[]).map(item => { return (<any>item) as LADSSampleInfo })

        this.enterMeasuring(context)
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
}
