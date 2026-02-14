// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Microwave Density & Moisture Analyzer
Copyright (C) 2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSFunctionalState, LADSTwoStateDiscreteSensorFunction, LADSAnalogScalarSensorFunction, LADSMultiSensorFunctionType, LADSMultiStateDiscreteSensorFunction } from "@interfaces"
import { promoteToFiniteStateMachine, setNumericValue, touchNodes, raiseEvent, setStringValue, addProgramTemplate, modifyStatusCode, getNumericValue, noise, sleepMilliSeconds, setNameNodeIdValue, EventDataRecorder, DataExporter, setSessionInformation, getDescriptionVariable, setPropertiesValue, setSamplesValue, setDateTimeValue, copyProgramTemplate, MulitStateDiscreteControlFunctionImpl, ProgramTemplateElement, copyValues, VariableDataRecorder, setNumericArrayValue, getStringValue, getNumericArrayValue } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantLike, SessionContext, CallMethodResultOptions, Variant, StatusCode, UAVariable, DataValue, VariantArrayType, UAObjectType } from "node-opcua"
import { MWDeviceImpl, Manufacturer, getMWNameSpace as getMWNameSpace } from "./device"
import { MeasurementResult, MWFunctionalUnit, MWFunctionSet, MWResult, ProductSet, ResultsEnum } from "./interfaces"
import { EventEmitter } from "events"
import { ComplianceDocumentReferences, ComplianceDocumentSetImpl } from "@utils"
import { join } from "path"
import { AnalogScalarSensorFunctionImpl } from "@utils"
import { Duration, LockImpl } from "utils/src/lads-lock"
import { ProductImpl, Products, ProductSetImpl } from "./products"

//---------------------------------------------------------------
interface CurrentRunOptions {
    programTemplateId: string
    runId: string,
    started: Date,
    startedMilliseconds: number
    estimatedRuntime?: number
    supervisoryJobId: string
    supervisoryTaskId: string
    programTemplate: ProgramTemplateOptions
    programTemplateNode: LADSProgramTemplate
    properties?: LADSProperty[]
    samples?: LADSSampleInfo[]
    result?: MWResult
    eventRecorder?: EventDataRecorder
    variableRecorder?: VariableDataRecorder
    variableRecorderTimer?: NodeJS.Timeout
}

export const DataDirectory = join(__dirname, "data")

class TemplateIds {
    static readonly Measure = "Measure"
    static readonly EmptyCheck = "Empty Check"
    static readonly CompressionTest = "Compression Test"
    static readonly CalibrateDensity = "Calibrate Density"
    static readonly CalibrateMoisture = "Calibrate Moisture"
}

interface ProgramTemplateOptions {
    name: string,
    description?: string
    template?: ProgramTemplateElement
}

const ProgramTemplates: ProgramTemplateOptions[] = [
    { name: TemplateIds.Measure },
    { name: TemplateIds.EmptyCheck },
    { name: TemplateIds.CompressionTest },
    { name: TemplateIds.CalibrateDensity },
    { name: TemplateIds.CalibrateMoisture },
]

const InitialDelay = 2 * Duration.Second

//---------------------------------------------------------------
// unit implementation
//---------------------------------------------------------------
export class MWUnitImpl extends EventEmitter {
    parent: MWDeviceImpl
    functionalUnit: MWFunctionalUnit
    functionalUnitState: UAStateMachineEx
    currentRunOptions: CurrentRunOptions
    pendingRequest: LADSFunctionalState
    documentSet: ComplianceDocumentSetImpl
    lock: LockImpl

    // simulator
    temperature: UAVariable
    density: UAVariable
    moisture: UAVariable

    // sensors
    temperatureSensor: AnalogScalarSensorFunctionImpl
    densitySensor: AnalogScalarSensorFunctionImpl
    moistureSensor: AnalogScalarSensorFunctionImpl
    resultIndicator: LADSMultiStateDiscreteSensorFunction 
    lightBarrier1: LADSTwoStateDiscreteSensorFunction
    lightBarrier2: LADSTwoStateDiscreteSensorFunction
    lightBarrier3: LADSTwoStateDiscreteSensorFunction

    // products
    selectedProductController: MulitStateDiscreteControlFunctionImpl
    productSet: ProductSetImpl
    selectedProduct: ProductImpl

    // results
    mwResultType: UAObjectType

    constructor(parent: MWDeviceImpl, optionals: string[] = []) {
        super()
        this.parent = parent

        // create unit object
        const functionalUnitSet = parent.getFunctionalUnitSet()
        const addressSpace = functionalUnitSet.addressSpace
        const mwUnitType = getMWNameSpace(addressSpace).findObjectType("MWUnitType")
        this.functionalUnit = mwUnitType.instantiate({
            browseName: "MWUnit",
            displayName: "MW Unit",
            componentOf: functionalUnitSet,
            optionals: optionals,
        }) as MWFunctionalUnit
        this.mwResultType = getMWNameSpace(addressSpace).findObjectType("MWResultType")

        // bind state machines
        const functionalUnit = this.functionalUnit
        const stateMachine = functionalUnit.functionalUnitState
        stateMachine.start?.bindMethod(this.start.bind(this))
        stateMachine.startProgram?.bindMethod(this.startProgram.bind(this))
        stateMachine.stop?.bindMethod(this.stop.bind(this))
        stateMachine.abort?.bindMethod(this.abort.bind(this))
        // promote & initialize state machines
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)

        // initialize lock
        if (functionalUnit.lock) {
            this.lock = new LockImpl(functionalUnit.lock, parent.lock)
        }

        // initialize products
        this.productSet = new ProductSetImpl(this.functionalUnit.getComponentByName("ProductSet") as ProductSet, Products)
        this.selectedProduct = this.productSet.products[0]

        // initialize function set
        const functionSet = this.functionalUnit.getComponentByName("FunctionSet") as MWFunctionSet

        // init sensors
        this.densitySensor = new AnalogScalarSensorFunctionImpl(functionSet.density, { lowLowLimit: 0.0, lowLimit: 0.1, highLimit: 2.0, highHighLimit: 4.0, historizing: true })
        this.moistureSensor = new AnalogScalarSensorFunctionImpl(functionSet.moisture, { lowLowLimit: 0.0, lowLimit: 20.0, highLimit: 40.0, highHighLimit: 100.0, historizing: true })
        this.temperatureSensor = new AnalogScalarSensorFunctionImpl(functionSet.temperature, { lowLowLimit: 0.0, lowLimit: 20.0, highLimit: 30, highHighLimit: 100.0, historizing: true })
        this.resultIndicator = functionSet.resultIndicator

        // init controller
        this.selectedProductController = new MulitStateDiscreteControlFunctionImpl(functionSet.selectedProduct)
        this.selectedProductController.initEnumStrings(Products.map(product => product.name))
        this.selectedProductController.targetValue.on("value_changed", this.onSelectedProductChanged.bind(this))

        // trigger initialization of sensor alarm-monitor limits according to selected product
        this.onSelectedProductChanged(this.selectedProductController.currentValue.readValue())

        // add AFO
        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.densitometry, AFODictionaryIds.humidity)
        AFODictionary.addSensorFunctionReferences(this.densitySensor.sensorFunction, AFODictionaryIds.densitometry)
        AFODictionary.addSensorFunctionReferences(this.moistureSensor.sensorFunction, AFODictionaryIds.humidity, AFODictionaryIds.relative_humidity)
        AFODictionary.addSensorFunctionReferences(this.temperatureSensor.sensorFunction, AFODictionaryIds.temperature, AFODictionaryIds.temperature_measurement)

        // experimental - create compliance-document-set & add DoC
        const device = this.parent.device
        const documentsDir = join(__dirname, "documents", device.browseName.name)
        this.documentSet = new ComplianceDocumentSetImpl(device, __dirname, documentsDir)

        // compliance documents
        if (true) {
            // add example docments from resoucres
            const dir = join(__dirname, "resources")
            const date = new Date()
            this.documentSet.addPDFFile("EU Declaration of Conformity (English)", date, join(dir, "MW55_DoC_en.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasDeclarationOfConformity }])
            this.documentSet.addPDFFile("EU Declaration of Conformity (German)", date, join(dir, "MW55_DoC_de.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasDeclarationOfConformity }])
            this.documentSet.addPDFFile("FCC Part 15 C (English)", date, join(dir, "MW55_FCC_en.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasComplianceDocument }])
            this.documentSet.addPDFFile("FCC Part 15 C (German)", date, join(dir, "MW55_FCC_de.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasComplianceDocument }])
            this.documentSet.addPDFFile("RF Exposure Statement (English)", date, join(dir, "MW55_RF_en.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasComplianceDocument }])
            this.documentSet.addPDFFile("RF Exposure Statement (German)", date, join(dir, "MW55_RF_de.pdf"), [{ node: device, reference: ComplianceDocumentReferences.HasComplianceDocument }])
        }

        // create simulation variables
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({ componentOf: functionalUnit, browseName: "Simulator" })
        this.density = namespace.addVariable({
            browseName: "Density",
            propertyOf: simulator,
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 0.7 }
        })
        this.moisture = namespace.addVariable({
            browseName: "Moisture",
            propertyOf: simulator,
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 42.0 }
        })
        this.temperature = namespace.addVariable({
            browseName: "Temperature",
            propertyOf: simulator,
            dataType: DataType.Double,
            value: { dataType: DataType.Double, value: 23 }
        })

        // init program manager
        this.initProgramTemplates()

        // start simlulation
        const dT = 500
        let runTime = 0
        setInterval(() => {
            this.evaluate(runTime, dT)
            runTime += dT
        }, dT)
    }

    private onSelectedProductChanged(dataValue: DataValue) {
        const value: number = dataValue.value.value
        setNumericValue(this.selectedProductController.currentValue, value)
        const productNames = this.selectedProductController.currentValue.enumStrings.readValue().value.value
        const name = productNames[value].text
        const product = this.productSet.findProduct(name)
        raiseEvent(this.functionalUnit, `Selected product changed to ${name}`)
        if (!product) return
        setNumericValue(this.densitySensor.alarmMonitor.lowLimit, product.densityLowLimit)
        setNumericValue(this.densitySensor.alarmMonitor.highLimit, product.densityHighLimit)
        setNumericValue(this.moistureSensor.alarmMonitor.lowLimit, product.moistureLowLimit)
        setNumericValue(this.moistureSensor.alarmMonitor.highLimit, product.moistureHighLimit)
        setNumericValue(this.temperatureSensor.alarmMonitor.lowLimit, product.temperatureLowLimit)
        setNumericValue(this.temperatureSensor.alarmMonitor.highLimit, product.temperatureHighLimit)
        this.selectedProduct = product
    }

    protected isAccessibleBy(sessionContext: SessionContext): boolean { return this.lock ? this.lock.isAccessibleBy(sessionContext) : true }

    private evaluate(runtime: number, dT: number) {
        function filterAndSet(yvar: UAVariable, xvar: UAVariable, distortion = 0.01) {
            const cf = 0.5
            const x = getNumericValue(xvar)
            const y = getNumericValue(yvar)
            const y_ =  cf * x + (1 - cf) * y
            setNumericValue(yvar, y_ + noise(distortion))
        }

        filterAndSet(this.densitySensor.sensorValue, this.density, 0.001)
        filterAndSet(this.moistureSensor.sensorValue, this.moisture, 0.1)
        filterAndSet(this.temperatureSensor.sensorValue, this.temperature, 0.01)
    }

    //---------------------------------------------------------------
    // program manager implementation
    //---------------------------------------------------------------
    private initProgramTemplates() {
        const programTemplateSet = this.functionalUnit.programManager.programTemplateSet as UAObject
        // pre-initialize nodeversion to avoid node-opcua stack messages
        setStringValue(programTemplateSet.getNodeVersion(), "0")
        const date = new Date(Date.parse("2025-02-09T00:00:00.000Z"))
        ProgramTemplates.forEach(programTemplate => {
            const template = addProgramTemplate(programTemplateSet, {
                identifier: programTemplate.name,
                description: programTemplate.description ?? "",
                author: Manufacturer,
                created: date,
                modified: date,
            })
            programTemplate.template = template
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
        const template = ProgramTemplates.find(programTemplate => programTemplate.template?.identifier.toLowerCase().includes(id))
        if (!template) return false
        const started = new Date()
        const iso = started.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        const deviceProgramRunId = `${date}-${time}-${this.name}-${template.name}`.replace(/[ (),°]/g, "")
        const seconds = this.selectedProduct?.samples ?? 20
        const runTime = Duration.Second * seconds + InitialDelay
        this.currentRunOptions = {
            programTemplateId: template.name,
            started: started,
            startedMilliseconds: Date.now(),
            estimatedRuntime: runTime,
            programTemplate: template,
            programTemplateNode: template.template.programTemplate,
            runId: deviceProgramRunId,
            supervisoryJobId: "",
            supervisoryTaskId: "",
        }
        return true
    }

    setStatusCodes(statusCode: StatusCode) {
        modifyStatusCode(this.densitySensor.sensorValue, statusCode)
        modifyStatusCode(this.moistureSensor.sensorValue, statusCode)
    }

    private get name(): string { return this.parent.config.name }

    protected async enterRunning(context: SessionContext) {
        const options = this.currentRunOptions

        // eventually create result structure
        if (options.programTemplateId === TemplateIds.Measure) {
            const resultType = getMWNameSpace(this.functionalUnit.addressSpace).findObjectType("MWResultType")
            const programManager = this.functionalUnit.programManager
            const resultSet = <UAObject>programManager.resultSet
            const result = <MWResult><unknown>resultType.instantiate({
                componentOf: resultSet,
                browseName: options.runId,
                optionals: ["NodeVersion", "FileSet.NodeVersion", "VariableSet.NodeVersion"]
            })
            options.result = result

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
            copyValues(this.selectedProduct?.product, result.variableSet.product)
            touchNodes(result)

            // create recorder
            options.eventRecorder = new EventDataRecorder("Events", this.functionalUnit)
            options.variableRecorder = new VariableDataRecorder("Data", [this.moistureSensor.sensorValue, this.densitySensor.sensorValue, this.temperatureSensor.sensorValue])
            setTimeout(() => options.variableRecorderTimer = setInterval(() => { options.variableRecorder.createRecord() }, 1000), InitialDelay)

            // initialize last result structure
            setNumericValue(this.resultIndicator.sensorValue, ResultsEnum.Unknown)
            setNameNodeIdValue(programManager.lastResult, options.runId, result.nodeId)
            copyValues(result, programManager.lastResultData)

            // set simualted process values
            if (this.selectedProduct) {

                function setSimulatedValue(variable: UAVariable, low: number, high: number, scale = 0.6) {
                    const average = 0.5 * (low + high)
                    const span = high - low
                    setNumericValue(variable, average + noise(scale * span))
                }

                const product = this.selectedProduct
                setSimulatedValue(this.density, product.densityLowLimit, product.densityHighLimit)
                setSimulatedValue(this.moisture, product.moistureLowLimit, product.moistureHighLimit)
                setSimulatedValue(this.temperature, product.temperatureLowLimit, product.temperatureHighLimit)              
            }

        } else if (options.programTemplateId === TemplateIds.EmptyCheck) {
            setNumericValue(this.density, noise(0.01))
            setNumericValue(this.moisture, noise(0.1))
        }
        raiseEvent(this.functionalUnit, `Starting method ${options.programTemplateId} with identifier ${options.runId}.`)


        const activeProgram = this.functionalUnit.programManager.activeProgram
        setNameNodeIdValue(activeProgram.currentProgramTemplate, options.programTemplateId, options.programTemplateNode.nodeId)
        setNumericValue(activeProgram.currentRuntime, 0)
        setNumericValue(activeProgram.estimatedRuntime, options.estimatedRuntime)
        setStringValue(activeProgram.deviceProgramRunId, options.runId)
        this.currentRunOptions = options
        this.pendingRequest = LADSFunctionalState.Running
        this.functionalUnitState.setState(LADSFunctionalState.Running)
        await this.run()
    }


    protected async run() {
        const options = this.currentRunOptions
        const activeProgram = this.functionalUnit.programManager.activeProgram
        const started = Date.now()
        let aborted = false
        let waiting = true

        while (waiting) {
            const now = Date.now()
            setNumericValue(activeProgram.currentRuntime, now - started)
            waiting = (now - started) < options.estimatedRuntime
            if ((this.pendingRequest === LADSFunctionalState.Stopping) || (this.pendingRequest === LADSFunctionalState.Aborted)) {
                waiting = false
                aborted = true
                this.leaveRunning(this.pendingRequest)
            } else {
                await sleepMilliSeconds(200)
            }
        }
        if (!aborted) this.leaveRunning(LADSFunctionalState.Stopping)
    }

    private async leaveRunning(state: LADSFunctionalState) {
        const stateMachine = this.functionalUnitState
        stateMachine.setState(state)
        const programManager = this.functionalUnit.programManager
        const options = this.currentRunOptions
        if (options) {
            this.currentRunOptions = undefined
            if (state === LADSFunctionalState.Aborting) {
                raiseEvent(this.functionalUnit, `Aborting method ${options.programTemplateId} with identifier ${options.runId}.`, 500)
                await sleepMilliSeconds(100)
            } else {
                raiseEvent(this.functionalUnit, `Finalized method ${options.programTemplateId} with identifier ${options.runId}.`, 100)
                await sleepMilliSeconds(100)
            }
            if (options.result) {
                // document results
                clearInterval(options.variableRecorderTimer)
                const result = options.result
                setDateTimeValue(result.stopped, new Date())
                const resultsDirectory = join(DataDirectory, "results")
                new DataExporter().writeXSLXResultFile(result.fileSet, "XLSX", resultsDirectory, options.runId, [options.eventRecorder, options.variableRecorder])

                // compute aggregates and set measurement results
                const variableSet = options.result.variableSet
                const recorder = options.variableRecorder
                const densityResult = this.setMeasurementResult(recorder, variableSet.density, this.densitySensor) 
                const moistureResult = this.setMeasurementResult(recorder, variableSet.moisture, this.moistureSensor) 
                this.setMeasurementResult(recorder, variableSet.temperature, this.temperatureSensor) 
                
                // set overall result indicator
                const resultIndicator = (densityResult === ResultsEnum.Passed) && (moistureResult === ResultsEnum.Passed) ? ResultsEnum.Passed : ResultsEnum.Failed
                setNumericValue(this.resultIndicator.sensorValue, resultIndicator)
                const resultEnumStrings = this.resultIndicator.sensorValue.enumStrings.readValue().value.value
                const resultText =  resultEnumStrings ? resultEnumStrings[resultIndicator].text : "Unknown"
                setStringValue(variableSet.result, resultText)

                // copy results
                copyValues(result, programManager.lastResultData)

                // remove sample (empty)
                // setNumericValue(this.density, noise(0.01))
                // setNumericValue(this.moisture, noise(0.1))

                touchNodes(result, result.fileSet, result.variableSet)
            }
            if (options.programTemplateId == TemplateIds.EmptyCheck) {
                setDateTimeValue(programManager.lastEmptyCheck, options.started)
            }
        } else {
            raiseEvent(this.functionalUnit, `Stopping method.`, 100)
        }
        stateMachine.setState(LADSFunctionalState.Stopped)
    }

    private setMeasurementResult(recorder: VariableDataRecorder, measurement: MeasurementResult, sensor: AnalogScalarSensorFunctionImpl): ResultsEnum {
        const variable = sensor.sensorValue
        const lowLimit = getNumericValue(sensor.alarmMonitor.lowLimit)
        const highLimit = getNumericValue(sensor.alarmMonitor.highLimit)
        const aggregates = recorder.createAggregates(variable)
        const average = aggregates.average
        setNumericValue(measurement.average, aggregates.average)
        setNumericValue(measurement.standardDeviation, aggregates.standardDeviation)
        setNumericArrayValue(measurement.samples, aggregates.values as number[])
        return (average >= lowLimit) && (average <= highLimit) ? ResultsEnum.Passed : ResultsEnum.Failed
    }

    private async start(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        const args: VariantLike[] = [
            { dataType: DataType.String, value: TemplateIds.Measure },
            { dataType: DataType.ExtensionObject, value: [], arrayType: VariantArrayType.Array },
            { dataType: DataType.String, value: "Unknown Job" },
            { dataType: DataType.String, value: "Measurement Task" },
            { dataType: DataType.ExtensionObject, value: [], arrayType: VariantArrayType.Array },
        ]
        return await this.startProgram(args, context)
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        if (this.initCurrentRunOptions(programTemplateId)) {
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


}
