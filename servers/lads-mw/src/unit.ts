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
import { LADSProgramTemplate, LADSProperty, LADSSampleInfo, LADSFunctionalState, LADSTwoStateDiscreteSensorFunction, LADSMultiStateDiscreteSensorFunction, LADSRunnnigState } from "@interfaces"
import { setNumericValue, touchNodes, raiseEvent, setStringValue, addProgramTemplate, modifyStatusCode, getNumericValue, noise, sleepMilliSeconds, setNameNodeIdValue, EventDataRecorder, DataExporter, setSessionInformation, getDescriptionVariable, setPropertiesValue, setSamplesValue, setDateTimeValue, copyProgramTemplate, MulitStateDiscreteControlFunctionImpl, ProgramTemplateElement, copyValues, VariableDataRecorder, setNumericArrayValue, setBooleanValue, LADSFiniteStateMachineHelper } from "@utils"
import { UAObject, DataType, UAStateMachineEx, StatusCodes, VariantLike, SessionContext, CallMethodResultOptions, Variant, StatusCode, UAVariable, DataValue, VariantArrayType, UAObjectType } from "node-opcua"
import { MWDeviceImpl, Manufacturer, getMWNameSpace as getMWNameSpace } from "./device"
import { MeasurementResult, MWFunctionalUnit, MWFunctionSet, MWResult, OperationModeEnum, ProductSet, ResultsEnum } from "./interfaces"
import { EventEmitter } from "events"
import { ComplianceDocumentReferences, ComplianceDocumentSetImpl } from "@utils"
import { join } from "path"
import { AnalogScalarSensorFunctionImpl } from "@utils"
import { Duration, LockImpl } from "utils/src/lads-lock"
import { ProductImpl, Products, ProductSetImpl } from "./products"

//---------------------------------------------------------------
interface CurrentRunOptions {
    context?: SessionContext
    operationMode: OperationModeEnum
    programTemplateId?: string
    properties?: LADSProperty[]
    supervisoryJobId?: string
    supervisoryTaskId?: string
    samples?: LADSSampleInfo[]
}

interface CurrentExecutionOptions {
    programTemplateId: string
    runId: string,
    started: Date,
    startedMilliseconds: number
    estimatedRuntime?: number
    executionTimer?: NodeJS.Timeout
    programTemplate: ProgramTemplateOptions
    programTemplateNode: LADSProgramTemplate
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
    runningStateMachine: UAStateMachineEx
    currentRunOptions: CurrentRunOptions = { operationMode: OperationModeEnum.Continuous }
    currentExecutionOptions: CurrentExecutionOptions
    documentSet: ComplianceDocumentSetImpl
    lock: LockImpl

    // simulator
    temperature: UAVariable
    density: UAVariable
    moisture: UAVariable
    simulateBales: UAVariable
    conveyorSpeed: UAVariable
    runBales = false
    transitionDelay: UAVariable

    // mode
    operationMode: MulitStateDiscreteControlFunctionImpl

    // sensors
    microwaveSensorOn: boolean = false
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
        const functionalUnitStateHelper = new LADSFiniteStateMachineHelper(stateMachine)
        const runningStateMachineHelper = new LADSFiniteStateMachineHelper(stateMachine.runningStateMachine, functionalUnitStateHelper, LADSFunctionalState.Running)
        this.functionalUnitState = functionalUnitStateHelper.stateMachine
        this.runningStateMachine = runningStateMachineHelper.stateMachine
        this.setFunctionalUnitState(LADSFunctionalState.Stopped)
        this.setRunningState(LADSRunnnigState.Idle)

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

        // init select product
        this.selectedProductController = new MulitStateDiscreteControlFunctionImpl(functionSet.selectedProduct)
        this.selectedProductController.initEnumStrings(Products.map(product => product.name))
        this.selectedProductController.targetValue.on("value_changed", this.onSelectedProductChanged.bind(this))

        // init operation mode
        if (functionSet.operationMode) {
            this.operationMode = new MulitStateDiscreteControlFunctionImpl(functionSet.operationMode)
            this.operationMode.targetValue.on("value_changed", this.onOperationModeChanged.bind(this))
        }

        // init light barriers
        this.lightBarrier1 = functionSet.lightBarrier1
        this.lightBarrier2 = functionSet.lightBarrier2
        this.lightBarrier3 = functionSet.lightBarrier3

        // trigger initialization of sensor alarm-monitor limits according to selected product
        this.onSelectedProductChanged(this.selectedProductController.currentValue.readValue())

        // add AFO
        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.densitometry, AFODictionaryIds.humidity)
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
            value: { dataType: DataType.Double, value: 0.65 }
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
        
        if (this.lightBarrier1) {
            this.runBales = false
            this.simulateBales = namespace.addVariable({
                browseName: "Simulate Bales",
                propertyOf: simulator,
                dataType: DataType.Boolean,
                value: { dataType: DataType.Boolean, value: this.runBales }
            })
            this.simulateBales.on("value_changed", (dataValue: DataValue) => { this.runBales = dataValue.value.value })
            this.conveyorSpeed = namespace.addVariable({
                browseName: "Conveyor Speed",
                displayName: "Conveyor Speed [mm/s]",
                propertyOf: simulator,
                dataType: DataType.Double,
                value: { dataType: DataType.Double, value: 50 }
            })
            setTimeout(() => this.evaluateBales())
        }
        this.transitionDelay = namespace.addVariable({
            browseName: "Transition Delay",
            displayName: "Transition Delay [ms]",
            propertyOf: simulator,
            dataType: DataType.UInt32,
            value: { dataType: DataType.UInt32, value: 10 }
        })
        

        // init program manager
        this.initProgramTemplates()

        // start simlulation
        const dT = 500
        setInterval(() => { this.evaluate(dT) }, dT)
    }

    private async delayTransition() { await sleepMilliSeconds(getNumericValue(this.transitionDelay))}

    private onSelectedProductChanged(dataValue: DataValue) {
        const value: number = dataValue.value.value
        setNumericValue(this.selectedProductController.currentValue, value)
        const name = this.selectedProductController.currentValueString
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

    private onOperationModeChanged(dataValue: DataValue) {
        const value: number = dataValue.value.value
        setNumericValue(this.operationMode.currentValue, value)
        raiseEvent(this.functionalUnit, `Operation mode changed to ${this.operationMode.currentValueString}`)
        // update simulation mode
        setBooleanValue(this.simulateBales, value === OperationModeEnum.Bale)
    }

    private get currentOperationMode(): OperationModeEnum {
        return getNumericValue(this.operationMode?.currentValue, OperationModeEnum.Continuous)
    }

    private setSimulatedProductValues() {
        if (!this.selectedProduct) return

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

    private setSimulatedEmptyValues() {
        setNumericValue(this.density, noise(0.01))
        setNumericValue(this.moisture, noise(0.1))
        setNumericValue(this.temperature, 25.0)
    }

    private setAlarmMonitorEnabledState(requestedEnabledState: boolean) {
        this.densitySensor.alarmMonitor.setEnabledState(requestedEnabledState)
        this.moistureSensor.alarmMonitor.setEnabledState(requestedEnabledState)
        this.temperatureSensor.alarmMonitor.setEnabledState(requestedEnabledState)
    }

    private async executeEmptyCheck() { 
        if (this.currentOperationMode === OperationModeEnum.Continuous) return 
        this.setAlarmMonitorEnabledState(false)
        this.enterExecuting(TemplateIds.EmptyCheck) 
    }
    private async completeEmptyCheck() { 
        if (this.currentOperationMode === OperationModeEnum.Continuous) return 
        this.setAlarmMonitorEnabledState(true)
        this.leaveExecuting() 
    }
    private async executeMeasureBale(id: number) { 
        if (this.currentOperationMode === OperationModeEnum.Continuous) return 
        const productName = this.selectedProduct ? this.selectedProduct.name : ""
        const sample: LADSSampleInfo = {
            sampleId: `${productName} Bale #${id}`,
            containerId: `Bale #${id}`,
            position: "",
            customData: ""
        }
        this.currentRunOptions.samples = [sample]
        this.setAlarmMonitorEnabledState(true)
        this.enterExecuting(TemplateIds.Measure) 
    }
    private async completeMeasureBale() { 
        if (this.currentOperationMode === OperationModeEnum.Continuous) return 
        this.leaveExecuting() 
    }

    private async evaluateBales() {
        let measureId = 0
        while (true) {
            const speed = getNumericValue(this.conveyorSpeed, 100)
            const scale = 1000 / (speed >= 10 ? speed : 10)
            if (this.runBales) {
                // bale approaches LB1
                setBooleanValue(this.lightBarrier1.sensorValue, true)
                // start empty check
                this.executeEmptyCheck()
                await sleepMilliSeconds(520 * scale)
                this.completeEmptyCheck()
                // bale approaches LB2
                setBooleanValue(this.lightBarrier2.sensorValue, true)
                await sleepMilliSeconds(240 * scale)
                // bale approaches sensor
                this.setSimulatedProductValues()
                await sleepMilliSeconds(240 * scale)
                // bale approaches LB3
                setBooleanValue(this.lightBarrier3.sensorValue, true)
                // start measurement now
                this.executeMeasureBale(++measureId)
                // bale is 100mm longer than lb distance
                await sleepMilliSeconds(100 * scale)
                // bale leaves LB1
                setBooleanValue(this.lightBarrier1.sensorValue, false)
                await sleepMilliSeconds(520 * scale)
                // bale leaves LB2
                setBooleanValue(this.lightBarrier2.sensorValue, false)
                // stop measurement now
                this.completeMeasureBale()
                await sleepMilliSeconds(240 * scale)
                // bale leaves sensor
                this.setSimulatedEmptyValues()
                await sleepMilliSeconds(240 * scale)
                // bale leaves LB3
                setBooleanValue(this.lightBarrier3.sensorValue, false)
                // wait for next bale 200mm in front of LB1
                await sleepMilliSeconds(200 * scale)
            } else {
                setBooleanValue(this.lightBarrier1.sensorValue, false)
                setBooleanValue(this.lightBarrier2.sensorValue, false)
                setBooleanValue(this.lightBarrier3.sensorValue, false)
                await sleepMilliSeconds(500)
            }
        }
    }

    private evaluate(dT: number) {
        function filterAndSet(yvar: UAVariable, xvar: UAVariable, distortion = 0.01) {
            const cf = 0.5
            const x = getNumericValue(xvar)
            const y = getNumericValue(yvar)
            const y_ = cf * x + (1 - cf) * y
            setNumericValue(yvar, y_ + noise(distortion))
        }
        this.microwaveSensorOn = this.isExecuting || this.currentOperationMode === OperationModeEnum.Continuous
        if (this.microwaveSensorOn) {
            filterAndSet(this.densitySensor.sensorValue, this.density, 0.001)
            filterAndSet(this.moistureSensor.sensorValue, this.moisture, 0.1)
        } else {
            this.setStatusCodes(StatusCodes.UncertainLastUsableValue)
        }
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

    protected isAccessibleBy(sessionContext: SessionContext): boolean { return this.lock ? this.lock.isAccessibleBy(sessionContext) : true }

    get isRunning(): boolean { return this.functionalUnitState.getCurrentState().includes(LADSFunctionalState.Running) }
    get isExecuting(): boolean { return this.runningStateMachine.getCurrentState().includes(LADSRunnnigState.Execute) }

    private readyToStart(): boolean {
        const currentState = this.functionalUnitState.getCurrentState();
        return (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted))
    }

    private readyToStop(): boolean {
        const currentState = this.functionalUnitState.getCurrentState();
        return (currentState.includes(LADSFunctionalState.Running))
    }

    private initCurrentRunOptions(context: SessionContext, programTemplateId: string, properties: LADSProperty[], supervisoryJobId: string, supervisoryTaskId: string, samples: LADSSampleInfo[]): boolean {
        const id = programTemplateId.toLowerCase()
        const template = ProgramTemplates.find(programTemplate => programTemplate.template?.identifier.toLowerCase().includes(id))
        if (!template) return false
        this.currentRunOptions = {
            context: context,
            operationMode: this.currentOperationMode,
            programTemplateId: programTemplateId,
            supervisoryJobId: supervisoryJobId,
            supervisoryTaskId: supervisoryTaskId,
            properties: properties,
            samples: samples,
        }
        return true
    }

    private initCurrentExecutionOptions(programTemplateId: string, estimatedSeconds = 20): boolean {
        const id = programTemplateId.toLowerCase()
        const template = ProgramTemplates.find(programTemplate => programTemplate.template?.identifier.toLowerCase().includes(id))
        if (!template) return false
        const started = new Date()
        const iso = started.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        // const deviceProgramRunId = `${date}-${time}-${this.name}-${template.name}`.replace(/[ (),°]/g, "")
        const samples = this.currentRunOptions?.samples
        const sampleId = samples ? samples.length > 0 ? `-${samples[0].sampleId}`.replace(" ", "-") : "" : ""    
        const deviceProgramRunId = `${date}-${time}-${template.name}${sampleId}`.replace(/[ (),°]/g, "")
        const seconds = this.selectedProduct?.samples ?? estimatedSeconds
        const estimatedRunTime = Duration.Second * seconds + InitialDelay
        this.currentExecutionOptions = {
            programTemplateId: template.name,
            started: started,
            startedMilliseconds: Date.now(),
            estimatedRuntime: estimatedRunTime,
            programTemplate: template,
            programTemplateNode: template.template.programTemplate,
            runId: deviceProgramRunId,
        }
        return true
    }

    setStatusCodes(statusCode: StatusCode) {
        modifyStatusCode(this.densitySensor.sensorValue, statusCode)
        modifyStatusCode(this.moistureSensor.sensorValue, statusCode)
    }

    private setFunctionalUnitState(state: LADSFunctionalState) {
        this.functionalUnitState.setState(state)
        console.debug(`Entering FunctionalUnitState ${state}`)
    }

    private setRunningState(state: LADSRunnnigState) {
        this.runningStateMachine.setState(state)
        console.debug(`Entering RunningState ${state}`)
    }

    private async enterRunning() {
        this.setFunctionalUnitState(LADSFunctionalState.Running)
        await this.delayTransition()
        if (this.currentOperationMode === OperationModeEnum.Continuous) {
            await this.enterExecuting(this.currentRunOptions.programTemplateId)
        }
    }

    private async enterExecuting(programTemplateId: string) {
        if (!this.isRunning) return
        this.setRunningState(LADSRunnnigState.Starting)
        await this.delayTransition()
        this.initCurrentExecutionOptions(programTemplateId)
        const runOptions = this.currentRunOptions
        const executionOptions = this.currentExecutionOptions

        // eventually create result structure
        if (executionOptions.programTemplateId === TemplateIds.Measure) {
            const resultType = getMWNameSpace(this.functionalUnit.addressSpace).findObjectType("MWResultType")
            const programManager = this.functionalUnit.programManager
            const resultSet = <UAObject>programManager.resultSet
            const result = <MWResult><unknown>resultType.instantiate({
                componentOf: resultSet,
                browseName: executionOptions.runId,
                optionals: ["NodeVersion", "FileSet.NodeVersion", "VariableSet.NodeVersion"]
            })
            executionOptions.result = result

            AFODictionary.addDefaultResultReferences(result)
            setSessionInformation(result, runOptions.context)
            setStringValue(getDescriptionVariable(result), `Run based on template ${executionOptions.programTemplateId}, started ${executionOptions.started.toLocaleDateString()}.`)
            setPropertiesValue(result.properties, runOptions.properties)
            setSamplesValue(result.samples, runOptions.samples)
            setStringValue(result.supervisoryJobId, runOptions.supervisoryJobId)
            setStringValue(result.supervisoryTaskId, runOptions.supervisoryTaskId)
            setStringValue(result.deviceProgramRunId, executionOptions.runId)
            setDateTimeValue(result.started, executionOptions.started)
            copyProgramTemplate(executionOptions.programTemplateNode, result.programTemplate)
            copyValues(this.selectedProduct?.product, result.variableSet.product)
            touchNodes(result)

            // create recorder
            executionOptions.eventRecorder = new EventDataRecorder("Events", this.functionalUnit)
            executionOptions.variableRecorder = new VariableDataRecorder("Data", [this.moistureSensor.sensorValue, this.densitySensor.sensorValue, this.temperatureSensor.sensorValue])
            setTimeout(() => executionOptions.variableRecorderTimer = setInterval(() => { executionOptions.variableRecorder.createRecord() }, 1000), InitialDelay)

            // initialize last result structure
            setNumericValue(this.resultIndicator.sensorValue, ResultsEnum.Unknown)
            setNameNodeIdValue(programManager.lastResult, executionOptions.runId, result.nodeId)
            copyValues(result, programManager.lastResultData)

            // set simualted process values
            this.setSimulatedProductValues()
        } else if (executionOptions.programTemplateId === TemplateIds.EmptyCheck) {
            this.setSimulatedEmptyValues()
        }
        this.currentExecutionOptions = executionOptions
        raiseEvent(this.functionalUnit, `Starting method ${executionOptions.programTemplateId} with identifier ${executionOptions.runId}.`)


        const activeProgram = this.functionalUnit.programManager.activeProgram
        setNameNodeIdValue(activeProgram.currentProgramTemplate, executionOptions.programTemplateId, executionOptions.programTemplateNode.nodeId)
        setNumericValue(activeProgram.currentRuntime, 0)
        setNumericValue(activeProgram.estimatedRuntime, executionOptions.estimatedRuntime)
        setStringValue(activeProgram.deviceProgramRunId, executionOptions.runId)
        this.currentExecutionOptions.executionTimer = setInterval(() => { this.execute()}, 500)
        this.setRunningState(LADSRunnnigState.Execute)
    }

    private async execute() {
        const executionOptions = this.currentExecutionOptions
        if (!executionOptions) {
            console.debug("currentExecutionOptions undefined")
            return
        }
        const now = Date.now()
        const currentRunTime = now - executionOptions.startedMilliseconds
        setNumericValue(this.functionalUnit.programManager.activeProgram.currentRuntime, currentRunTime)
        if ((currentRunTime > executionOptions.estimatedRuntime) && (this.currentOperationMode === OperationModeEnum.Continuous)) {
            if (this.isRunning) await this.leaveRunning(LADSFunctionalState.Stopping)
        }            
    }

    private async leaveExecuting() {
        if (!this.isExecuting) return
        this.setRunningState(LADSRunnnigState.Completing)
        await this.delayTransition()
        await this.completeExecution()
        this.setRunningState(LADSRunnnigState.Complete)
        await this.delayTransition()
        this.setRunningState(LADSRunnnigState.Resetting)
        await this.delayTransition()
        this.setRunningState(LADSRunnnigState.Idle)
        await this.delayTransition()
    }

    private async completeExecution() {
        if (!this.currentExecutionOptions) return
        const programManager = this.functionalUnit.programManager
        const executionOptions = this.currentExecutionOptions
        clearInterval(executionOptions.executionTimer)
        if (executionOptions.result) {
            // document results
            clearInterval(executionOptions.variableRecorderTimer)
            const result = executionOptions.result
            setDateTimeValue(result.stopped, new Date())
            const resultsDirectory = join(DataDirectory, "results")
            new DataExporter().writeXSLXResultFile(result.fileSet, "XLSX", resultsDirectory, executionOptions.runId, [executionOptions.eventRecorder, executionOptions.variableRecorder])

            // compute aggregates and set measurement results
            const variableSet = executionOptions.result.variableSet
            const recorder = executionOptions.variableRecorder
            const densityResult = this.setMeasurementResult(recorder, variableSet.density, this.densitySensor)
            const moistureResult = this.setMeasurementResult(recorder, variableSet.moisture, this.moistureSensor)
            this.setMeasurementResult(recorder, variableSet.temperature, this.temperatureSensor)

            // set overall result indicator
            const resultIndicator = (densityResult === ResultsEnum.Passed) && (moistureResult === ResultsEnum.Passed) ? ResultsEnum.Passed : ResultsEnum.Failed
            setNumericValue(this.resultIndicator.sensorValue, resultIndicator)
            const resultEnumStrings = this.resultIndicator.sensorValue.enumStrings.readValue().value.value
            const resultText = resultEnumStrings ? resultEnumStrings[resultIndicator].text : "Unknown"
            setStringValue(variableSet.result, resultText)

            // copy results
            copyValues(result, programManager.lastResultData)
            touchNodes(result, result.fileSet, result.variableSet)
        }
        if (executionOptions.programTemplateId == TemplateIds.EmptyCheck) {
            setDateTimeValue(programManager.lastEmptyCheck, executionOptions.started)
        }
        this.currentExecutionOptions = undefined
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
    private async leaveRunning(functionalState: LADSFunctionalState) {
        const executionOptions = this.currentExecutionOptions
        if (this.isExecuting) this.leaveExecuting()
        if (functionalState === LADSFunctionalState.Stopping) {
            this.setFunctionalUnitState(LADSFunctionalState.Stopping)
            if (executionOptions) raiseEvent(this.functionalUnit, `Finalized method ${executionOptions.programTemplateId} with identifier ${executionOptions.runId}.`, 100)
            await this.delayTransition()
            this.setFunctionalUnitState(LADSFunctionalState.Stopped)
        } else if (functionalState === LADSFunctionalState.Aborting) {
            this.setFunctionalUnitState(LADSFunctionalState.Aborting)
            if (executionOptions) raiseEvent(this.functionalUnit, `Aborting method ${executionOptions.programTemplateId} with identifier ${executionOptions.runId}.`, 500)
            await this.delayTransition()
            this.setFunctionalUnitState(LADSFunctionalState.Aborted)
        }
    }

    private async start(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        const args: VariantLike[] = [
            { dataType: DataType.String, value: TemplateIds.Measure },
            { dataType: DataType.ExtensionObject, value: [], arrayType: VariantArrayType.Array },
            { dataType: DataType.String, value: "Unknown Job" },
            { dataType: DataType.String, value: "Measurement Task" },
            { dataType: DataType.ExtensionObject, value: [], arrayType: VariantArrayType.Array },
        ]
        //return await this.startProgram(args, context)
        const result = await this.startProgram(args, context)
        return { statusCode: result.statusCode }
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {

        function stringValue(variant: VariantLike, defaultValue = "") { return variant === null ? defaultValue : variant.value }
        function properties(variant: VariantLike): LADSProperty[] { return variant === null ? [] : (variant.value as Variant[]).map(item => { return (<any>item) as LADSProperty }) }
        function samples(variant: VariantLike): LADSSampleInfo[] { return variant === null ? [] : (variant.value as Variant[]).map(item => { return (<any>item) as LADSSampleInfo }) }

        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplate = stringValue(inputArguments[0])
        const valid = this.initCurrentRunOptions(
            context,
            programTemplate,
            properties(inputArguments[1]),
            stringValue(inputArguments[2]),
            stringValue(inputArguments[3]),
            samples(inputArguments[4]))

        if (valid) {
            this.enterRunning()
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: this.currentExecutionOptions?.runId ?? programTemplate})],
                statusCode: StatusCodes.Good
            }
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }
        }
    }

    private async stop(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveRunning(LADSFunctionalState.Stopping)
        return { statusCode: StatusCodes.Good }
    }

    private async abort(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.isAccessibleBy(context)) return { statusCode: StatusCodes.BadLocked }
        if (!this.readyToStop()) return { statusCode: StatusCodes.BadInvalidState }
        this.leaveRunning(LADSFunctionalState.Aborting)
        return { statusCode: StatusCodes.Good }
    }


}
