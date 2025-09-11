// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS pH-Meter
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
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSResult, LADSAnalogScalarSensorFunction, LADSActiveProgram, LADSFunctionalState } from "@interfaces"
import { getLADSObjectType, getDescriptionVariable, promoteToFiniteStateMachine, getNumericValue, setNumericValue, getNumericArrayValue, touchNodes, raiseEvent, setStringValue, setDateTimeValue, copyProgramTemplate, setPropertiesValue, setSamplesValue, setSessionInformation, ProgramTemplateElement, addProgramTemplate } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantLike, SessionContext, CallMethodResultOptions, Variant } from "node-opcua"
import { join } from "path"
import { BalanceDeviceImpl } from "./device"
import { BalanceFunctionalUnit, BalanceFunctionSet } from "./interfaces"
import { BalanceRecorder } from "@asm"

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
    recorder?: BalanceRecorder
    recorderInterval?: NodeJS.Timer
    runtimeInterval?: NodeJS.Timer
}

export class ProgramTemplateIds {
    static readonly RegisterWeight = "Register Weight"
    static readonly SetTare = "Set Tare"
    static readonly SetPresetTare = "Set Preset Tare"
    static readonly ClearTare = "Clear Tare"
    static readonly SetZero = "Set Zero"
}

//---------------------------------------------------------------
export abstract class BalanceUnitImpl {
    parent: BalanceDeviceImpl
    functionalUnit: BalanceFunctionalUnit
    functionalUnitState: UAStateMachineEx
    balanceSensor: LADSAnalogScalarSensorFunction
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    currentRunOptions: CurrentRunOptions
    programTemplateElements: ProgramTemplateElement[] = []

    constructor(parent: BalanceDeviceImpl, functionalUnit: BalanceFunctionalUnit) {
        this.parent = parent

        // init functional unit & state machine
        this.functionalUnit = functionalUnit
        const stateMachine = functionalUnit.functionalUnitState
        stateMachine.start.bindMethod(this.start.bind(this))
        stateMachine.startProgram.bindMethod(this.startProgram.bind(this))
        stateMachine.stop.bindMethod(this.stop.bind(this))
        
        stateMachine.abort.bindMethod(this.abort.bind(this))
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)

        // init sensors
        const addressSpace = this.functionalUnit.addressSpace
        const functionSet = true ? this.functionalUnit.getComponentByName("FunctionSet") as BalanceFunctionSet : functionalUnit.functionSet
        // balance sensor
        this.balanceSensor = functionSet.balanceSensor
        this.balanceSensor.sensorValue.historizing = true
        addressSpace.installHistoricalDataNode(this.balanceSensor.sensorValue)

        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.weighing_device)
        AFODictionary.addSensorFunctionReferences(this.balanceSensor, AFODictionaryIds.weighing, AFODictionaryIds.sample_weight)

        // init program manager
        this.initProgramTemplates()
    }

    
    abstract get simulationMode(): boolean

    //---------------------------------------------------------------
    // program manager implementation
    //---------------------------------------------------------------
    private initProgramTemplates() {
        const programTemplateSet = this.functionalUnit.programManager.programTemplateSet as UAObject
        const date = new Date(Date.parse("2025-04-01T00:00:00.000Z"))
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.RegisterWeight,
            description: "Weigh sample and create result record.",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.weighing, AFODictionaryIds.sample_weight],
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.SetTare,
            description: "Tare balance",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing, AFODictionaryIds.tare_weight]
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.SetPresetTare,
            description: "Set tare to a preset value provided as property 'tare=<value>'. Tare will be cleared when no property is provided.",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing, AFODictionaryIds.tare_weight]
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.ClearTare,
            description: "Clear tare value.",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing, AFODictionaryIds.tare_weight]
        }))
        this.programTemplateElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.SetZero,
            description: "Zero balance",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.weighing]
        }))
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

    private initCurrentRunOptions(template: ProgramTemplateElement) {
        const started = new Date()
        const iso = started.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        const deviceProgramRunId = `${date}-${time}-${template.identifier.replace(/[ (),°]/g, "")}`
        this.currentRunOptions = {
            programTemplateId: template.identifier,
            started: started,
            startedMilliseconds: Date.now(),
            estimatedRuntimeMilliseconds: 60000,
            programTemplate: template.programTemplate,
            runId: deviceProgramRunId,
            supervisoryJobId: "",
            supervisoryTaskId: "",
        }
    }

    protected enterMeasuring(context: SessionContext) {
        const options = this.currentRunOptions
        const programTemplateId = options.programTemplateId
        if (programTemplateId !== ProgramTemplateIds.RegisterWeight) {
            // execute simple command
            raiseEvent(this.functionalUnit, `Execting method ${programTemplateId}`)
            switch (programTemplateId) {
            case ProgramTemplateIds.SetTare:
                break;
            default:
            }
        } else {
            raiseEvent(this.functionalUnit, `Starting method ${programTemplateId} with identifier ${options.runId}.`)

            // additional references for calibration
            const referenceIds: string[] = [AFODictionaryIds.weighing, AFODictionaryIds.weighing_aggregate_document, AFODictionaryIds.weighing_document, AFODictionaryIds.weighing_result]

            // create result
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

            // build ASM recorder
            options.recorder = new BalanceRecorder({
                devices: [{ device: this.parent.device, deviceType: "Balance" }],
                sample: options.samples[0],
                result: result,
                runtime: this.functionalUnit.programManager.activeProgram.currentRuntime,
                sampleWeight: this.balanceSensor.sensorValue,
                grossWeight: this.balanceSensor.rawValue
            })
            this.simulationMode ? options.recorderInterval = setInterval(() => { options.recorder.createRecord() }, 2000) : 0
            options.recorder.addReferenceIds(...referenceIds)


            // runtime recording
            const activeProgram = this.functionalUnit.programManager.activeProgram
            setNumericValue(activeProgram.currentRuntime, 0)
            setNumericValue(activeProgram.estimatedRuntime, options.estimatedRuntimeMilliseconds)
            options.runtimeInterval = setInterval(() => {
                const runtime = Date.now() - options.startedMilliseconds
                setNumericValue(activeProgram.currentRuntime, runtime)
                if (runtime > options.estimatedRuntimeMilliseconds) {
                    this.leaveMeasuring(LADSFunctionalState.Stopping)
                }
            }, 500)
            this.functionalUnitState.setState(LADSFunctionalState.Running)
        }
    }

    private leaveMeasuring(state: LADSFunctionalState) {
        const stateMachine = this.functionalUnitState
        stateMachine.setState(state)

        const options = this.currentRunOptions
        if (!options) {
            // if options not defined simply leave
            stateMachine.setState(LADSFunctionalState.Stopped)
            raiseEvent(this.functionalUnit, `Stopping run.`, 100)
        } else {
            // clear timers
            clearInterval(options.runtimeInterval)
            options.recorderInterval ? clearInterval(options.recorderInterval) : 0
            const result = options.result
            if (state === LADSFunctionalState.Aborting) {
                // delete result and leave
                result?.namespace.deleteNode(options.result)
                stateMachine.setState(LADSFunctionalState.Aborted)
                raiseEvent(this.functionalUnit, `Aborting method ${options.programTemplateId} with identifier ${options.runId}.`, 500)
            } else if (result) {
                // set stopped timestamp
                setDateTimeValue(result.stopped, new Date())

                // add end-points
                const variableSet = result.variableSet
                const referenceIds = []

                // read endpoint values
                const sampleWeight = getNumericValue(this.balanceSensor.sensorValue) // pH
                const grossWeight = getNumericValue(this.balanceSensor.rawValue) // mV
                const calibrationValues: number[] = getNumericArrayValue(this.balanceSensor.calibrationValues)

                // create result variables
                const sampleWeightResult = result.namespace.addVariable({
                    componentOf: variableSet,
                    browseName: "net weight",
                    description: "weighing endpoint",
                    dataType: DataType.Double,
                    value: { dataType: DataType.Double, value: sampleWeight }
                })
                AFODictionary.addReferences(sampleWeightResult, AFODictionaryIds.weighing_result, AFODictionaryIds.sample_weight)
                // create ASM
                const model = options.recorder.createModel()
                const resultsDirectory = join(__dirname, "data", "results")
                options.recorder.writeResultFile(result.fileSet, "ASM", resultsDirectory, options.runId, model)
                const json = JSON.stringify(model, null, 2)
                const asm = result.namespace.addVariable({
                    componentOf: variableSet,
                    browseName: "ASM",
                    dataType: DataType.String,
                    value: { dataType: DataType.String, value: json }
                })
                AFODictionary.addReferences(asm, AFODictionaryIds.ASM_file, AFODictionaryIds.weighing, AFODictionaryIds.weighing_document, AFODictionaryIds.weighing_result, ...referenceIds)


                // set state to stopped and leave    
                stateMachine.setState(LADSFunctionalState.Stopped)
                raiseEvent(this.functionalUnit, `Finalized method ${options.programTemplateId} with identifier ${options.runId}.`, 100)
            }
            // touch everything
            this.touchResult()
        }
        this.currentRunOptions = undefined
    }

    private findProgramTemplate(programTemplateId: string): ProgramTemplateElement {
        const id = programTemplateId.toLowerCase()
        return this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(id))
    }

    private async start(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        // search properties for sampleId
        const propertiesValue = inputArguments[0].value
        const properties = propertiesValue === null ? [] : (propertiesValue as Variant[]).map(item => { return (<any>item) as LADSProperty })
        const sampleProperty = properties.find(property => (property.key.toLocaleLowerCase().includes("sampleId")))
        const sampleId: string = sampleProperty ? sampleProperty.value : "Unknown"
        const sampleInfo: LADSSampleInfo = { containerId: "", sampleId: sampleId, position: "", customData: "" }

        // create options
        this.initCurrentRunOptions(this.findProgramTemplate(ProgramTemplateIds.RegisterWeight))
        const options = this.currentRunOptions
        options.properties = properties
        options.samples = [sampleInfo]

        this.enterMeasuring(context)
        return { statusCode: StatusCodes.Good }
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        const programTemplate = this.programTemplateElements.find(value => value.identifier.toLowerCase().includes(programTemplateId.toLowerCase()))
        if (programTemplate) {
            this.initCurrentRunOptions(programTemplate)
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
        const samples = samplesValue === null ? [] : (samplesValue as Variant[]).map(item => { return (<any>item) as LADSSampleInfo })
        if (samples.length === 0) samples.push({ containerId: "4711", sampleId: "08150001", position: "1", customData: "" })
        options.samples = samples

        this.enterMeasuring(context)
    }

    private async stop(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveMeasuring(LADSFunctionalState.Stopping)
        return { statusCode: StatusCodes.Good }
    }
    private async abort(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveMeasuring(LADSFunctionalState.Aborting)
        return { statusCode: StatusCodes.Good }
    }
}
