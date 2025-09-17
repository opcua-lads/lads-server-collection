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
import { pHSensorRecorder } from "@asm"
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSResult, LADSAnalogScalarSensorFunction, LADSAnalogScalarSensorWithCompensationFunction, LADSActiveProgram, LADSFunctionalState } from "@interfaces"
import { getLADSObjectType, getDescriptionVariable, promoteToFiniteStateMachine, getNumericValue, setNumericValue, getNumericArrayValue, touchNodes, raiseEvent, setStringValue, setDateTimeValue, copyProgramTemplate, setNumericArrayValue, setPropertiesValue, setSamplesValue, setSessionInformation, addProgramTemplate, ProgramTemplateElement } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantArrayType, VariantLike, SessionContext, CallMethodResultOptions, Variant } from "node-opcua"
import { join } from "path"
import { pHMeterDeviceImpl } from "./ph-meter-device"
import { pHMeterFunctionalUnit, pHMeterFunctionSet } from "./ph-meter-interfaces"

//---------------------------------------------------------------
interface CurrentRunOptions {
    programTemplateId: string
    runId: string,
    started: Date,
    startedMilliseconds: number
    estimatedRuntimeMilliseconds: number
    referenceValue: number
    programTemplate: LADSProgramTemplate
    supervisoryJobId: string
    supervisoryTaskId: string
    properties?: LADSProperty[]
    samples?: LADSSampleInfo[]
    result?: LADSResult
    recorder?: pHSensorRecorder
    recorderInterval?: NodeJS.Timer
    runtimeInterval?: NodeJS.Timer
}

export class ProgramTemplateIds {
    static readonly Measure = "Measure"
    static readonly CalibrateOffset = "Calibrate Offset"
    static readonly CalibrateSlope = "Calibrate Slope"
}

export class Constants {
    static readonly R = 8.314
    static readonly F = 96485
    static readonly T0 = 273.15
}

//---------------------------------------------------------------
export abstract class pHMeterUnitImpl {
    parent: pHMeterDeviceImpl
    functionalUnit: pHMeterFunctionalUnit
    functionalUnitState: UAStateMachineEx
    temperatureSensor: LADSAnalogScalarSensorFunction
    pHSensor: LADSAnalogScalarSensorWithCompensationFunction
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    currentRunOptions: CurrentRunOptions
    programTemplatesElements: ProgramTemplateElement[] = []

    constructor(parent: pHMeterDeviceImpl, functionalUnit: pHMeterFunctionalUnit) {
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
        const functionSet = true ? this.functionalUnit.getComponentByName("FunctionSet") as pHMeterFunctionSet : functionalUnit.functionSet
        // pH sensor
        this.pHSensor = true ? functionSet.getComponentByName("pHSensor") as LADSAnalogScalarSensorWithCompensationFunction : functionSet.pHSensor
        this.pHSensor.sensorValue.historizing = true
        addressSpace.installHistoricalDataNode(this.pHSensor.sensorValue)
        // temperature sensor
        this.temperatureSensor = functionSet.getComponentByName("TemperatureSensor") as LADSAnalogScalarSensorFunction
        this.temperatureSensor.sensorValue.historizing = true
        addressSpace.installHistoricalDataNode(this.temperatureSensor.sensorValue)

        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.pH_measurement)
        AFODictionary.addSensorFunctionReferences(this.pHSensor, AFODictionaryIds.pH_measurement, AFODictionaryIds.pH)
        AFODictionary.addReferences(this.pHSensor.compensationValue, AFODictionaryIds.temperature)
        AFODictionary.addSensorFunctionReferences(this.temperatureSensor, AFODictionaryIds.temperature_measurement, AFODictionaryIds.temperature)

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
        this.programTemplatesElements.push(addProgramTemplate(programTemplateSet, {
            identifier: ProgramTemplateIds.Measure,
            description: "pH-Measurement",
            author: "AixEngineers",
            created: date,
            modified: date,
            referenceIds: [AFODictionaryIds.pH_measurement, AFODictionaryIds.pH]
        }))
        if (this.simulationMode) {
            this.programTemplatesElements.push(addProgramTemplate(programTemplateSet, {
                identifier: ProgramTemplateIds.CalibrateOffset,
                description: "Perform pH-sensor offset calibration (default buffer pH=7). For other calibration buffers provide a property 'buffer=<value>'.",
                author: "AixEngineers",
                created: date,
                modified: date,
                referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.pH]
            }))
            this.programTemplatesElements.push(addProgramTemplate(programTemplateSet, {
                identifier: ProgramTemplateIds.CalibrateSlope,
                description: "Perform pH-sensor slope calibration (default buffer pH=4). For other calibration buffers provide a property 'buffer=<value>'.",
                author: "AixEngineers",
                created: date,
                modified: date,
                referenceIds: [AFODictionaryIds.calibration, AFODictionaryIds.pH, AFODictionaryIds.pH_calibration_slope]
            }))
        }
        touchNodes(programTemplateSet)
    }

    private touchResult() {
        const result = this.currentRunOptions.result
        touchNodes(this.functionalUnit.programManager.resultSet as UAObject, result, result.fileSet, result.variableSet)
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
            referenceValue: 7.0
        }
    }

    protected enterMeasuring(context: SessionContext) {
        const options = this.currentRunOptions
        raiseEvent(this.functionalUnit, `Starting method ${options.programTemplateId} with identifier ${options.runId}.`)

        // additional references for calibration
        const referenceIds: string[] = [AFODictionaryIds.pH_measurement, AFODictionaryIds.pH_monitoring_aggregate_document]
        if (options.programTemplateId === ProgramTemplateIds.CalibrateOffset) {
            referenceIds.push(AFODictionaryIds.calibration, AFODictionaryIds.calibration_report)
        } else if (options.programTemplateId === ProgramTemplateIds.CalibrateSlope) {
            referenceIds.push(AFODictionaryIds.calibration, AFODictionaryIds.calibration_report, AFODictionaryIds.pH_calibration_slope)
        }

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
        options.recorder = new pHSensorRecorder({
            devices: [{ device: this.parent.device, deviceType: "pH-Meter" }],
            sample: options.samples[0],
            result: result,
            runtime: this.functionalUnit.programManager.activeProgram.currentRuntime,
            pH: this.pHSensor.sensorValue,
            temperature: this.pHSensor.compensationValue
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

        // remember settings and start
        this.functionalUnitState.setState(LADSFunctionalState.Running)
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
            const variableSet = result.variableSet
            if (state === LADSFunctionalState.Aborting) {
                // delete result and leave
                options.result.namespace.deleteNode(options.result)
                stateMachine.setState(LADSFunctionalState.Aborted)
                raiseEvent(this.functionalUnit, `Aborting method ${options.programTemplateId} with identifier ${options.runId}.`, 500)
            } else {
                // set stopped timestamp
                setDateTimeValue(result.stopped, new Date())

                // add end-points
                const isSlopeCalibration = options.programTemplateId === ProgramTemplateIds.CalibrateSlope
                const isOffsetCalibration = options.programTemplateId === ProgramTemplateIds.CalibrateOffset
                const isCalibration = isSlopeCalibration || isOffsetCalibration
                const referenceIds = isCalibration ? [AFODictionaryIds.calibration] : []

                // read endpoint values
                const pHEndpoint = getNumericValue(this.pHSensor.sensorValue) // pH
                const temperatureEndpoint = getNumericValue(this.pHSensor.compensationValue) // °C
                const pHRawEndpoint = getNumericValue(this.pHSensor.rawValue) // mV
                const voltageEndpoint = 0.001 * pHRawEndpoint // V
                const calibrationValues: number[] = getNumericArrayValue(this.pHSensor.calibrationValues)

                // eventually do calibration
                if (isOffsetCalibration) {
                    const offset = options.referenceValue - 7.0 + voltageEndpoint / (Constants.R * (temperatureEndpoint + Constants.T0) / Constants.F * Math.log(10) * 0.01 * calibrationValues[1])
                    if ((-1.0 < offset) && (offset < 1.0)) {
                        calibrationValues[0] = offset
                        setNumericArrayValue(this.pHSensor.calibrationValues, calibrationValues)
                        raiseEvent(this.functionalUnit, `Performed offset calibration with reference ${options.referenceValue}pH and offset parameter ${offset}pH.`, 200)
                    }
                } else if (isSlopeCalibration) {
                    const slope = 100.0 * voltageEndpoint / ((Constants.R * (temperatureEndpoint + Constants.T0) / Constants.F) * Math.log(10) * (7.0 + calibrationValues[0] - options.referenceValue))
                    if ((80.0 < slope) && (slope < 105.0)) {
                        calibrationValues[1] = slope
                        setNumericArrayValue(this.pHSensor.calibrationValues, calibrationValues)
                        raiseEvent(this.functionalUnit, `Performed slope calibration with reference ${options.referenceValue}pH and slope parameter ${slope}%.`, 200)
                    }
                    referenceIds.push(AFODictionaryIds.pH_calibration_slope)
                }

                // create result variables
                const pH = result.namespace.addVariable({
                    componentOf: variableSet,
                    browseName: "pH",
                    description: "pH measurement endpoint (with calibration values at begin of mesaurement)",
                    dataType: DataType.Double,
                    value: { dataType: DataType.Double, value: pHEndpoint }
                })
                AFODictionary.addReferences(pH, AFODictionaryIds.pH_measurement, AFODictionaryIds.pH)
                const temperature = result.namespace.addVariable({
                    componentOf: variableSet,
                    browseName: "Temperature",
                    description: "Temperature measurement endpoint [°C]",
                    dataType: DataType.Double,
                    value: { dataType: DataType.Double, value: temperatureEndpoint }
                })
                AFODictionary.addReferences(temperature, AFODictionaryIds.temperature_measurement, AFODictionaryIds.temperature)
                if (isCalibration) {
                    const pHRaw = result.namespace.addVariable({
                        componentOf: variableSet,
                        browseName: "pH.Raw",
                        description: "pH sensor voltage mesaurement endpoint [V]",
                        dataType: DataType.Double,
                        value: { dataType: DataType.Double, value: voltageEndpoint }
                    })
                    AFODictionary.addReferences(pHRaw, AFODictionaryIds.voltage)
                    const referenceBuffer = result.namespace.addVariable({
                        componentOf: variableSet,
                        browseName: "pH.Reference",
                        description: "pH reference buffer value",
                        dataType: DataType.Double,
                        value: { dataType: DataType.Double, value: options.referenceValue }
                    })
                    AFODictionary.addReferences(referenceBuffer, AFODictionaryIds.reference, AFODictionaryIds.pH)
                    const calibrationsValueVariable = result.namespace.addVariable({
                        componentOf: variableSet,
                        browseName: "CalibrationValues",
                        description: "pH sensor calibration values calualted based on reference buffer and endpoint values",
                        dataType: DataType.Double,
                        value: { dataType: DataType.Double, value: calibrationValues, arrayType: VariantArrayType.Array }
                    })
                    AFODictionary.addReferences(calibrationsValueVariable, AFODictionaryIds.calibration)
                }

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
                AFODictionary.addReferences(asm, AFODictionaryIds.ASM_file, AFODictionaryIds.pH_monitoring_aggregate_document, ...referenceIds)


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
        return this.programTemplatesElements.find(value => value.identifier.toLowerCase().includes(id))
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
        this.initCurrentRunOptions(this.findProgramTemplate(ProgramTemplateIds.Measure))
        const options = this.currentRunOptions
        options.properties = properties
        options.samples = [sampleInfo]

        this.enterMeasuring(context)
        return { statusCode: StatusCodes.Good }
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        const programTemplate = this.programTemplatesElements.find(value => value.identifier.toLowerCase().includes(programTemplateId.toLowerCase()))
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
