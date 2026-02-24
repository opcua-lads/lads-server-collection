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
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSResult, LADSFunctionalState, LADSRunnnigState, MachineryOperationMode, LADSAnalogControlFunction } from "@interfaces"
import { promoteToFiniteStateMachine, setNumericValue, touchNodes, raiseEvent, setStringValue, addProgramTemplate, modifyStatusCode, getNumericValue, installVariableHistory, noise, sleepMilliSeconds, MaintenanceTaskImpl, LADSMaintenanceTaskResult, setNameNodeIdValue, EventDataRecorder, DataExporter, getLADSObjectType, setSessionInformation, getDescriptionVariable, setPropertiesValue, setSamplesValue, setDateTimeValue, copyProgramTemplate, getLADSNamespace, AnalogControlFunctionImpl, AlarmMonitorOptions } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantLike, SessionContext, CallMethodResultOptions, Variant, StatusCode, UAVariable, DataValue, LocalizedText, BaseNode, AddressSpace } from "node-opcua"
import { WpsDeviceImpl, getWpsNameSpace } from "./device"
import { WpsFunctionalUnit, WpsFunctionSet } from "./interfaces"
import { EventEmitter } from "events"
import { ComplianceDocumentReferences, ComplianceDocumentSetImpl } from "@utils"
import { join } from "path"
import { AnalogScalarSensorFunctionImpl } from "@utils"
import { WpsProgramTemplate, ProgramTemplateTuple, ProgramTemplateDispense, ProgramTemplateReplaceCartridge, ProgramTemplateReplaceEndfilter, ProgramTemplateDepressurization, ProgramTemplateSanitization, ProgramTemplateFlushTOC, ProgramTemplateReplaceUVLamp, DispenseId, WpsProgramTemplateStep, ProgramTemplateRecalibrateTOC } from "./templates"
import { DispenseModeControlFunctionImpl, DispenseTimerControlFunctionImpl, DispenseVolumeControlFunctionImpl } from "./functions"
import { LockImpl } from "utils/src/lads-lock"

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
    eventRecorder?: EventDataRecorder
}

export const DataDirectory = join(__dirname, "data")

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
// unit implementation
//---------------------------------------------------------------
export class WpsUnitImpl extends EventEmitter {
    parent: WpsDeviceImpl
    functionalUnit: WpsFunctionalUnit
    functionalUnitState: UAStateMachineEx
    runningState: UAStateMachineEx
    programTemplates: ProgramTemplateTuple[] = []
    currentRunOptions: CurrentRunOptions
    pendingRequest: LADSFunctionalState
    documentSet: ComplianceDocumentSetImpl
    lock: LockImpl

    // simulator
    inletConductivity: UAVariable
    outletConductivity: UAVariable
    flow: UAVariable
    temperature: UAVariable
    toc: UAVariable

    // sensors
    inletConductivitySensor: AnalogScalarSensorFunctionImpl
    outletConductivitySensor: AnalogScalarSensorFunctionImpl
    temperatureSensor: AnalogScalarSensorFunctionImpl
    tocSensor: AnalogScalarSensorFunctionImpl

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
        optionals.push(
            "FunctionSet.DispenseVolume.ControlFunctionState.StartWithTargetValue",
            "FunctionSet.DispenseTime.ControlFunctionState.StartWithTargetValue")
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
        this.transiteReset()
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
        this.deactivateRunnnigState()

        // initialize lock
        if (functionalUnit.lock) {
            this.lock = new LockImpl(functionalUnit.lock, parent.lock)
        }

        // init sensors
        const functionSet = this.functionalUnit.getComponentByName("FunctionSet") as WpsFunctionSet
        // conductivity sensors
        this.inletConductivitySensor = new AnalogScalarSensorFunctionImpl(functionSet.inletConductivity, { lowLowLimit: -0.1, lowLimit: 0.0, highLimit: 16.0, highHighLimit: 20.0 })
        this.outletConductivitySensor = new AnalogScalarSensorFunctionImpl(functionSet.outletConductivity, { lowLowLimit: -0.01, lowLimit: 0.0, highLimit: 0.16, highHighLimit: 0.2 })
        this.temperatureSensor = new AnalogScalarSensorFunctionImpl(functionSet.temperature, { lowLowLimit: 0.0, lowLimit: 10.0, highLimit: 35, highHighLimit: 40 })
        this.tocSensor = functionSet.TOC ? new AnalogScalarSensorFunctionImpl(functionSet.TOC, { lowLowLimit: -0.1, lowLimit: -0.1, highLimit: 10, highHighLimit: 20 }) : undefined
        installVariableHistory(this.inletConductivitySensor.sensorValue)
        installVariableHistory(this.outletConductivitySensor.sensorValue)
        installVariableHistory(this.temperatureSensor.sensorValue)
        installVariableHistory(this.tocSensor?.sensorValue)

        // add AFO
        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.purification)
        AFODictionary.addSensorFunctionReferences(this.inletConductivitySensor.sensorFunction, AFODictionaryIds.electric_conductivity)
        AFODictionary.addSensorFunctionReferences(this.outletConductivitySensor.sensorFunction, AFODictionaryIds.electric_conductivity)
        AFODictionary.addSensorFunctionReferences(this.temperatureSensor.sensorFunction, AFODictionaryIds.temperature, AFODictionaryIds.temperature_measurement)

        // experimental - create compliance-document-set & add DoC
        const device = this.parent.device
        const documentsDir = join(__dirname, "documents", device.browseName.name)
        this.documentSet = new ComplianceDocumentSetImpl(device, __dirname, documentsDir)

        // compliance documents
        // this.documentSet.load()
        if (true) {
            // add example docments from resoucres
            const dir = join(__dirname, "resources")
            const docDocument = this.documentSet.addPDFFile("EU Declaration of Conformity", new Date(), join(dir, "sartorius arium doc.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasDeclarationOfConformity }])
            AFODictionary.addReferences(docDocument, AFODictionaryIds.conformance_assessment)
            // this.documentSet.save()
        }

        // create simulation variables
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({ componentOf: functionalUnit, browseName: "Simulator" })
        this.inletConductivity = namespace.addVariable({
            browseName: "Inlet Conductivity",
            propertyOf: simulator,
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 10 }
        })
        this.outletConductivity = namespace.addVariable({
            browseName: "Outlet Conductivity",
            propertyOf: simulator,
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.1 }
        })
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
        if (this.tocSensor) {
            this.toc = namespace.addVariable({
                browseName: "TOC",
                propertyOf: simulator,
                dataType: DataType.Double,
                value: { dataType: DataType.Double, value: 2.0 }
            })
            this.toc.on("value_changed", (dataValue) => setNumericValue(this.tocSensor.sensorValue, dataValue.value.value))
        }

        // controller alarm test
        if (true) {
            const analogControlFunctionType = getLADSNamespace(functionalUnit.addressSpace).findObjectType("AnalogControlFunctionType")
            const tc = analogControlFunctionType.instantiate({
                componentOf: functionSet,
                browseName: "Temperature Controller",
                optionals: ["ControlFunctionState.Start", "ControlFunctionState.Stop"]
            }) as LADSAnalogControlFunction
            const temperatureController = new AnalogControlFunctionImpl(tc, {
                lowLimit: -1,
                lowLowLimit: -2,
                highLimit: 1,
                highHighLimit: 2
            })
            setNumericValue(tc.currentValue, 25)
            setNumericValue(tc.targetValue, 37)
            this.temperature.on("value_changed", (dataValue: DataValue) => setNumericValue(tc.currentValue, dataValue.value.value))
            // temperatureController.alarmMonitor.setEnabledState(false)
        }

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

    protected isAccessibleBy(sessionContext: SessionContext): boolean { return this.lock ? this.lock.isAccessibleBy(sessionContext) : true }

    private evaluate(runtime: number, dT: number) {
        this.dispenseTimeController.evaluate()
        this.dispenseVolumeController.evaluate()
        const cycleTime = 60000.0
        const y = 1.0 + 0.5 * (Math.sin(2 * Math.PI * runtime / cycleTime))
        setNumericValue(this.inletConductivitySensor.sensorValue, getNumericValue(this.inletConductivity) * (y + noise(0.05)))
        setNumericValue(this.outletConductivitySensor.sensorValue, getNumericValue(this.outletConductivity) * (y + noise(0.05)))
        setNumericValue(this.temperatureSensor.sensorValue, getNumericValue(this.temperature) + noise(0.05))
        setNumericValue(this.tocSensor?.sensorValue, getNumericValue(this.toc) + noise(0.01))
    }

    //---------------------------------------------------------------
    // program manager implementation
    //---------------------------------------------------------------
    private initProgramTemplates() {
        const programTemplateSet = this.functionalUnit.programManager.programTemplateSet as UAObject
        // pre-initialize nodeversion to avoid node-opcua stack messages
        setStringValue(programTemplateSet.getNodeVersion(), "0")
        const date = new Date(Date.parse("2025-09-01T00:00:00.000Z"))
        const config = this.parent.config
        const programTemplates: WpsProgramTemplate[] = [
            ProgramTemplateDispense,
            ProgramTemplateReplaceCartridge,
            ProgramTemplateReplaceEndfilter,
            ProgramTemplateDepressurization,
            ProgramTemplateSanitization,
        ]
        if (config.hasTOC) programTemplates.push(ProgramTemplateFlushTOC, ProgramTemplateRecalibrateTOC)
        if (config.hasUV) programTemplates.push(ProgramTemplateReplaceUVLamp)
        programTemplates.forEach(template => {
            const node = addProgramTemplate(programTemplateSet, {
                identifier: template.name,
                description: template.description,
                author: "AixEngineers",
                created: date,
                modified: date,
                referenceIds: [AFODictionaryIds.preventative_maintenance],
            }).programTemplate
            this.programTemplates.push({ template: template, node: node })
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

    protected async enterRunning(context: SessionContext) {
        const options = this.currentRunOptions

        // eventually create result structure
        if (options.programTemplateId != DispenseId) {
            const resultType = getLADSObjectType(this.functionalUnit.addressSpace, "ResultType")
            const resultSet = <UAObject>this.functionalUnit.programManager.resultSet
            options.result = <LADSResult><unknown>resultType.instantiate({
                componentOf: resultSet,
                browseName: options.runId,
                optionals: ["NodeVersion", "FileSet.NodeVersion", "VariableSet.NodeVersion"]
            })
            const result = options.result
            AFODictionary.addDefaultResultReferences(result)
            setSessionInformation(result, context)
            setStringValue(getDescriptionVariable(result), `Run based on template ${options.programTemplateId}, started ${options.started.toLocaleDateString()}.`)
            setPropertiesValue(result.properties, options.properties)
            setSamplesValue(result.samples, options.samples)
            setStringValue(result.supervisoryJobId, options.supervisoryJobId)
            setStringValue(result.supervisoryTaskId, options.supervisoryTaskId)
            setStringValue(result.deviceProgramRunId, options.runId)
            setDateTimeValue(result.started, options.started)
            copyProgramTemplate(options.programTemplateNode, result.programTemplate)
            touchNodes(result)
            options.eventRecorder = new EventDataRecorder("Events", this.functionalUnit)
        }
        raiseEvent(this.functionalUnit, `Starting method ${options.programTemplateId} with identifier ${options.runId}.`)

        // eventually enter maintenance mode
        if (options.programTemplate.maintenanceMode) {
            this.parent.deviceHelper.enterOperationMode(MachineryOperationMode.Maintenance)
        }

        // find associated maintenance task (if any)
        if (options.programTemplate.component) {
            const component = this.parent.getComponent(options.programTemplate.component)
            const maintenanceTask = component?.task
            if (maintenanceTask) {
                await sleepMilliSeconds(100)
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
        this.currentRunOptions = options
        this.pendingRequest = LADSFunctionalState.Running
        this.functionalUnitState.setState(LADSFunctionalState.Running)
        await this.transiteStart()
        await this.run()
    }


    protected enterStep(step: WpsProgramTemplateStep, stepNumber: number) {
        const activeProgram = this.functionalUnit.programManager.activeProgram
        setNumericValue(activeProgram.currentStepNumber, stepNumber + 1)
        setStringValue(activeProgram.currentStepName, step.name)
        setNumericValue(activeProgram.currentStepRuntime, 0.0)
        setNumericValue(activeProgram.estimatedStepRuntime, step.duration ? step.duration : 0)
        const message = `${step.name}`
        if (step.confirmation) {
            this.transiteHold()
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
                    if ((this.pendingRequest === LADSFunctionalState.Stopping) || (this.pendingRequest === LADSFunctionalState.Aborted)) {
                        waiting = false
                        aborted = true
                        this.leaveRunning(this.pendingRequest)
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
            this.currentRunOptions = undefined
            if (state === LADSFunctionalState.Aborting) {
                raiseEvent(this.functionalUnit, `Aborting method ${options.programTemplateId} with identifier ${options.runId}.`, 500)
                await sleepMilliSeconds(100)
                options.maintenanceTask?.enterFinished(LADSMaintenanceTaskResult.Failure, { dataType: DataType.LocalizedText, value: "Task aborted" })
            } else {
                raiseEvent(this.functionalUnit, `Finalized method ${options.programTemplateId} with identifier ${options.runId}.`, 100)
                await sleepMilliSeconds(100)
                options.maintenanceTask?.enterFinished(LADSMaintenanceTaskResult.Success)
            }
            if (options.result) {
                // document results
                const result = options.result
                setDateTimeValue(result.stopped, new Date())
                const resultsDirectory = join(DataDirectory, "results")
                new DataExporter().writeXSLXResultFile(result.fileSet, "XLSX", resultsDirectory, options.runId, [options.eventRecorder])
                touchNodes(result, result.fileSet)
            }
            if (options.programTemplate?.maintenanceMode) {
                // go back to processing mode
                this.parent.deviceHelper.enterOperationMode(MachineryOperationMode.Processing)
            }
        } else {
            raiseEvent(this.functionalUnit, `Stopping method.`, 100)
        }
        await this.dispenseModeController.enterStop()
        await this.dispenseTimeController.enterStop()
        await this.transiteReset()
        stateMachine.setState(LADSFunctionalState.Stopped)
    }

    private async startDispense(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
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
        this.enterRunning(context)
        controller.enterStart()
        controller.on("stop", () => this.pendingRequest = LADSFunctionalState.Stopping)
        return { statusCode: StatusCodes.Good }
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
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

            this.enterRunning(context)
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: this.currentRunOptions.runId })],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async stop(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.pendingRequest = LADSFunctionalState.Stopping
        return { statusCode: StatusCodes.Good }
    }

    private async abort(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.pendingRequest = LADSFunctionalState.Aborting
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
    private async transiteStart() { this.transiteRunningState(LADSRunnnigState.Idle, LADSRunnnigState.Starting, LADSRunnnigState.Execute) }
    private async transiteHold() { this.transiteRunningState(LADSRunnnigState.Execute, LADSRunnnigState.Holding, LADSRunnnigState.Held) }
    private async transiteUnhold() { this.transiteRunningState(LADSRunnnigState.Held, LADSRunnnigState.Unholding, LADSRunnnigState.Execute) }
    private async transiteSuspend() { this.transiteRunningState(LADSRunnnigState.Execute, LADSRunnnigState.Suspending, LADSRunnnigState.Suspended) }
    private async transiteUnsuspend() { this.transiteRunningState(LADSRunnnigState.Suspended, LADSRunnnigState.Unsuspending, LADSRunnnigState.Execute) }
    private async transiteToComplete() { this.transiteRunningState(LADSRunnnigState.Execute, LADSRunnnigState.Completing, LADSRunnnigState.Complete) }
    private async transiteReset(wait = 1): Promise<StatusCode> {
        this.runningState.setState(LADSRunnnigState.Resetting)
        sleepMilliSeconds(wait)
        this.runningState.setState(LADSRunnnigState.Idle)
        return StatusCodes.Good
    }

    private async resume(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
        if (this.isHeld) {
            this.transiteUnhold()
            return { statusCode: StatusCodes.Good }
        } else if (this.isSuspended) {
            this.transiteUnsuspend()
            return { statusCode: StatusCodes.Good }
        } else {
            return { statusCode: StatusCodes.BadInvalidState }
        }
    }
}
