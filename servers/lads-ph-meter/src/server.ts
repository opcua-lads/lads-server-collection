// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AccessLevelFlag, ApplicationType, assert, CallMethodResultOptions, coerceNodeId, DataType, OPCUAServer, SessionContext, StatusCodes, UAObject, UAStateMachineEx, UAVariable, Variant, VariantArrayType, VariantLike } from "node-opcua"
import { join } from "path"
import { LADSActiveProgram, LADSAnalogScalarSensorFunction, LADSAnalogScalarSensorWithCompensationFunction, LADSComponent, LADSDevice, LADSFunctionalState, LADSFunctionalUnit, 
    LADSProgramTemplate, LADSProperty, LADSResult, LADSSampleInfo } from "@interfaces"
import { constructPropertiesExtensionObject, constructSamplesExtensionObject, copyProgramTemplate, defaultLocation, DIObjectIds, 
    getChildObjects, getDescriptionVariable, getLADSObjectType, 
    initComponent, LADSComponentOptions, LADSDeviceHelper, promoteToFiniteStateMachine, raiseEvent, touchNodes } from "@utils"
import { AFODictionary, AFODictionaryIds } from "@afo"
import { pHSensorRecorder } from "@asm"
import { getNumericArrayValue, getNumericValue, getStringValue, setDateTimeValue, setNumericArrayValue, setNumericValue, setStringValue } from "@utils"

//---------------------------------------------------------------
const IncludeAFO = true

//---------------------------------------------------------------
// interfaces
//---------------------------------------------------------------
interface pHMeterFunctionSet extends UAObject {
    temperatureSensor: LADSAnalogScalarSensorFunction
    pHSensor: LADSAnalogScalarSensorWithCompensationFunction
}

interface pHMeterFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: pHMeterFunctionSet
}

interface pHMeterFunctionalUnitSet extends UAObject {
    pHMeterUnit: pHMeterFunctionalUnit
}
interface pHMeterDevice extends Omit<LADSDevice, "functionalUnitSet, components"> {
    functionalUnitSet: pHMeterFunctionalUnitSet
    components: phMeterComponents
}

interface phMeterComponents extends UAObject {
    pHSensor: LADSComponent
}

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------
class pHMeterServerImpl {
    server: OPCUAServer

    constructor(port: number) {
        const uri = "LADS-pH-Meter-Server"
        console.log(`${uri} starting ${IncludeAFO?"with AFO support (takes some time to load) ..":".."}`);

        // provide paths for the nodeset files
        const nodeset_path = join(__dirname, '../../../../nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_phmeter = join(nodeset_path, 'pHMeter.xml')

        try {
            // list of node-set files
            const node_set_filenames = IncludeAFO?[nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_afo, nodeset_phmeter,]:[nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_phmeter,]

            // build the server object
            this.server = new OPCUAServer({
                port: port,
                // basic information about the server
                buildInfo: {
                    manufacturerName: "AixEngineers",
                    productName: uri,
                    productUri: uri,
                    softwareVersion: "1.0.0",
                },
                serverInfo: {
                    applicationName: "LADS pH-Meter",
                    applicationType: ApplicationType.Server,
                    productUri: uri,
                    applicationUri: "LADS-SampleServer", // utilize the default certificate

                },
                // nodesets used by the server
                nodeset_filename: node_set_filenames,
            })

        }
        catch (err) {
            console.log(err)
        }
    }

    async start(serialPort: string) {
        // wait until server initialized
        await this.server.initialize()

        // build structure
        const addressSpace = this.server.engine.addressSpace
        const nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        const nameSpacepH = addressSpace.getNamespace("http://spectaris.de/pHMeter/")
        assert(nameSpacepH)
        const deviceType = nameSpacepH.findObjectType("pHMeterDeviceType")
        assert(deviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nameSpaceDI.index))
        assert(deviceSet)
        const deviceImplementations: pHMeterDeviceImpl[] = []
        const devices = getChildObjects(deviceSet)
        devices.forEach(device => {
            if (device.typeDefinitionObj === deviceType) {
                const pHMeterDevice = device as pHMeterDevice
                const index = deviceImplementations.length
                pHMeterDevice.serialNumber.setValueFromSource({dataType: DataType.String, value: (4711 + index).toString()})
                deviceImplementations.push(new pHMeterDeviceImpl(pHMeterDevice, serialPort))
            }
        })

        // finalize start
        await this.server.start()
        const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl;
        console.log(this.server.buildInfo.productName, "is ready on", endpoint);
        console.log("CTRL+C to stop");
    }
}

//---------------------------------------------------------------
// device implementation
//---------------------------------------------------------------
class pHMeterDeviceImpl {
    device: pHMeterDevice
    
    constructor(device: pHMeterDevice, serialPort: string) {
        this.device = device
        if (true) {
            const fus = device.getComponentByName("FunctionalUnitSet") as pHMeterFunctionalUnitSet
            const fu = fus.getComponentByName("pHMeterUnit") as pHMeterFunctionalUnit
            new pHMeterUnitImpl(this, fu) 
        } else {
            const fus = device.functionalUnitSet
            console.log(fus.pHMeterUnit)
            const fu = fus.pHMeterUnit
            new pHMeterUnitImpl(this, fu)
        }
        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: getStringValue(device.manufacturer, "Mettler Toledo"),
            model: getStringValue(device.model, "Super pH-Meter"),
            serialNumber: getStringValue(device.serialNumber, "4711"),
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: "My pH-meter",
            location: defaultLocation,
        }
        initComponent(device, deviceOptions)
        const components = device.getComponentByName("Components")
        const sensor = components.getComponentByName("pHSensor") as LADSComponent
        const sensorOptions: LADSComponentOptions = {
            manufacturer: "Mettler Toledo",
            model: "DPAS 405",
            serialNumber: "0815",
        }
        initComponent(sensor, sensorOptions)
        
        // attach device helper
        const helper = new LADSDeviceHelper(device)

        // set dictionary entries
        AFODictionary.addDefaultDeviceReferences(device)
        AFODictionary.addReferences(device, AFODictionaryIds.measurement_device, AFODictionaryIds.pH_measurement)
    }
}

//---------------------------------------------------------------
// functional unit implementation
//---------------------------------------------------------------
interface ProgramTemplateOptions {
    identifier: string
    description: string
    author: string
    created: Date
    modified: Date
    version?: string
    referenceIds?: string[]
}

interface ProgramTemplateElement {identifier: string, programTemplate: LADSProgramTemplate}

function addProgramTemplate(programTemplateSet: UAObject, options: ProgramTemplateOptions): ProgramTemplateElement {
    if (!programTemplateSet) return
    const programTemplateType = getLADSObjectType(programTemplateSet.addressSpace, "ProgramTemplateType")
    const programTemplate = programTemplateType.instantiate({
        componentOf: programTemplateSet,
        browseName: options.identifier
    }) as LADSProgramTemplate
    getDescriptionVariable(programTemplate).setValueFromSource({dataType: DataType.LocalizedText, value: options.description})
    programTemplate.author.setValueFromSource({dataType: DataType.String, value: options.author})
    programTemplate.deviceTemplateId.setValueFromSource({dataType: DataType.String, value: options.identifier})
    programTemplate.created.setValueFromSource({dataType: DataType.DateTime, value: options.created})
    programTemplate.modified.setValueFromSource({dataType: DataType.DateTime, value: options.modified})
    if (options.referenceIds) { AFODictionary.addReferences(programTemplate, ...options.referenceIds)}
    return { identifier: options.identifier, programTemplate: programTemplate }
}

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

class ProgramTemplateIds {
    static readonly Measure = "Measure"
    static readonly CalibrateOffset = "Calibrate Offset"
    static readonly CalibrateSlope = "Calibrate Slope"
}

class Constants {
    static readonly R = 8.314
    static readonly F = 96485
    static readonly T0 = 273.15
}

class pHMeterUnitImpl {
    parent: pHMeterDeviceImpl
    functionalUnit: pHMeterFunctionalUnit
    functionalUnitState: UAStateMachineEx
    temperatureSensor: LADSAnalogScalarSensorFunction
    pHSensor: LADSAnalogScalarSensorWithCompensationFunction
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    currentRunOptions: CurrentRunOptions
    programTemplatesElements: ProgramTemplateElement[] = []

    simpHPV: UAVariable
    simpHOfs: UAVariable
    simpHSlope: UAVariable
    simpHRaw: UAVariable
    simTPV: UAVariable
    simTOfs: UAVariable
    simTSlope: UAVariable
    simTRaw: UAVariable

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
        const functionSet = true?this.functionalUnit.getComponentByName("FunctionSet") as pHMeterFunctionSet:functionalUnit.functionSet
        // pH sensor
        this.pHSensor = true?functionSet.getComponentByName("pHSensor") as LADSAnalogScalarSensorWithCompensationFunction:functionSet.pHSensor
        this.pHSensor.sensorValue.historizing = true
        addressSpace.installHistoricalDataNode(this.pHSensor.sensorValue)
        // temperature sensor
        this.temperatureSensor = functionSet.getComponentByName("TemperatureSensor") as LADSAnalogScalarSensorFunction
        this.temperatureSensor.sensorValue.historizing = true
        addressSpace.installHistoricalDataNode(this.temperatureSensor.sensorValue)

        // init simulator
        const namespace = functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: functionalUnit,
            browseName: "Simulator"
        })
        this.simpHPV = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.PV",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 6.0}
        })
        this.simpHSlope = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.Slope",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 100.0}
        })
        this.simpHOfs = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.Offset",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 0.0}
        })
        this.simpHRaw = namespace.addVariable({
            componentOf: simulator,
            browseName: "pH.Raw",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 0.0},
            accessLevel: AccessLevelFlag.CurrentRead
        })
        this.simTPV = namespace.addVariable({
            componentOf: simulator,
            browseName: "T.PV",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 25.0},
        })
        this.simTRaw = namespace.addVariable({
            componentOf: simulator,
            browseName: "T.Raw",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 1000.0},
            accessLevel: AccessLevelFlag.CurrentRead
        })
        AFODictionary.addReferences(functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.pH_measurement)
        AFODictionary.addSensorFunctionReferences(this.pHSensor, AFODictionaryIds.pH_measurement, AFODictionaryIds.pH )
        AFODictionary.addReferences(this.pHSensor.compensationValue, AFODictionaryIds.temperature)
        AFODictionary.addSensorFunctionReferences(this.temperatureSensor, AFODictionaryIds.temperature_measurement, AFODictionaryIds.temperature)

        // init program manager
        this.initProgramTemplates()
        
        // start run loop
        const dT = 200 
        setInterval( () => {this.evaluate(dT)}, dT)
    }

    private evaluate(dT: number) {
        const R0 = 1000

        const isMeasuring = this.functionalUnitState.getCurrentState().includes(LADSFunctionalState.Running)
        const lastpH = getNumericValue(this.pHSensor.sensorValue)
        const lastT = getNumericValue(this.temperatureSensor.sensorValue)

        if (true) {
            // compute simulated sensor values
            const simpH = getNumericValue(this.simpHPV)
            const simSlope = getNumericValue(this.simpHSlope)
            const simOfs = getNumericValue(this.simpHOfs)
            const simT = getNumericValue(this.simTPV)
            const simRaw = 1000.0 * Math.log(10) * Constants.R * (simT + Constants.T0) / Constants.F *  (7.0 + simOfs - simpH) * 0.01 * simSlope // mV
            const simR = R0 * (1 + 0.00385 * simT) // Ohm
            setNumericValue(this.simpHRaw, simRaw)
            setNumericValue(this.simTRaw, simR)
            
            // set sensor raw values with some additional noise
            const snsRaw = simRaw + 0.5 * (Math.random() - 0.5)
            const snsR = simR + 0.1 * (Math.random() - 0.5)
            setNumericValue(this.pHSensor.rawValue, snsRaw)
            setNumericValue(this.temperatureSensor.rawValue, snsR)

            // compute sensor values
            const cf = dT / 5000 // filter constant 5s
            const T = ((snsR / R0) - 1) / 0.00385
            const snsT = (1.0 - cf) * lastT + cf * T
            setNumericValue(this.temperatureSensor.sensorValue, snsT)
            setNumericValue(this.pHSensor.compensationValue, snsT)
            
            const cal: number[] = getNumericArrayValue(this.pHSensor.calibrationValues)
            const snsOfs = cal[0]
            const snsSlope = cal[1]
            const pH = 7.0 + snsOfs - 0.001 * snsRaw  / (0.01 * snsSlope) * Constants.F/(Math.log(10) * Constants.R * (snsT + Constants.T0))
            const snspH = (1.0 - cf) * lastpH + cf * pH
            setNumericValue(this.pHSensor.sensorValue, snspH)
        } else {
            setNumericValue(this.temperatureSensor.sensorValue, lastT, StatusCodes.UncertainLastUsableValue)
            setNumericValue(this.pHSensor.sensorValue, lastpH, StatusCodes.UncertainLastUsableValue)
        }
    }

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
        touchNodes(programTemplateSet)
    }

    private touchResult() {
        touchNodes(this.functionalUnit.programManager.resultSet as UAObject, this.currentRunOptions.result)
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
        const deviceProgramRunId = `${date}-${time}-${template.identifier.replace(/[ (),°]/g,"")}`
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

    private enterMeasuring() {
        const addressSpace = this.functionalUnit.addressSpace
        const options = this.currentRunOptions
        raiseEvent(this.functionalUnit, `Starting method ${options.programTemplateId} with identifier ${options.runId}.`)

        // set simulated pH
        const pHValues: {id: string,  value: number}[] = [
            {id: ProgramTemplateIds.Measure, value: 7.0 + 6.0 * (Math.random() - 0.5)},
            {id: ProgramTemplateIds.CalibrateOffset, value: 7},
            {id: ProgramTemplateIds.CalibrateSlope, value: 4},
        ]
        const pHPropertyKey = options.programTemplateId === ProgramTemplateIds.Measure?"ph":"buffer"
        const pHProperty = options.properties?.find(property => property.key.toLowerCase().includes(pHPropertyKey))
        options.referenceValue = pHProperty?Number(pHProperty.value):pHValues.find(value => value.id === options.programTemplateId).value
        setNumericValue(this.simpHPV, options.referenceValue)

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
            optionals: ["NodeVersion", "VariableSet.NodeVersion"] 
        })
        const result = options.result
        AFODictionary.addDefaultResultReferences(result)
        AFODictionary.addReferences(result, ...referenceIds)
        setStringValue(getDescriptionVariable(result), `Run based on template ${options.programTemplateId}, started ${options.started.toLocaleDateString()}.`)
        result.properties?.setValueFromSource( {dataType: DataType.ExtensionObject, value: constructPropertiesExtensionObject(addressSpace, options.properties), arrayType: VariantArrayType.Array})
        result.samples?.setValueFromSource( {dataType: DataType.ExtensionObject, value: constructSamplesExtensionObject(addressSpace, options.samples), arrayType: VariantArrayType.Array})
        setStringValue(result.supervisoryJobId, options.supervisoryJobId)
        setStringValue(result.supervisoryTaskId, options.supervisoryTaskId)
        setStringValue(result.deviceProgramRunId, options.runId )
        setDateTimeValue(result.started, options.started)
        copyProgramTemplate(options.programTemplate, result.programTemplate)
        this.touchResult()

        // build ASM recorder
        options.recorder = new pHSensorRecorder({
            devices: [{device: this.parent.device, deviceType: "pH-Meter"}],
            sample: options.samples[0],
            result: result,
            runtime: this.functionalUnit.programManager.activeProgram.currentRuntime,
            pH: this.pHSensor.sensorValue,
            temperature: this.pHSensor.compensationValue
        })
        options.recorderInterval = setInterval(() => {options.recorder.createRecord()}, 2000)
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
            clearInterval(options.recorderInterval)
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
                const referenceIds = isCalibration?[AFODictionaryIds.calibration]:[]

                // read endpoint values
                const pHEndpoint =  getNumericValue(this.pHSensor.sensorValue) // pH
                const temperatureEndpoint =  getNumericValue(this.pHSensor.compensationValue) // °C
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
                    value: {dataType: DataType.Double, value: pHEndpoint}
                })
                AFODictionary.addReferences(pH, AFODictionaryIds.pH_measurement, AFODictionaryIds.pH)
                const temperature = result.namespace.addVariable({
                    componentOf: variableSet,
                    browseName: "Temperature",
                    description: "Temperature measurement endpoint [°C]",
                    dataType: DataType.Double,
                    value: {dataType: DataType.Double, value: temperatureEndpoint}
                })
                AFODictionary.addReferences(temperature, AFODictionaryIds.temperature_measurement, AFODictionaryIds.temperature)
                if (isCalibration) {
                    const pHRaw = result.namespace.addVariable({
                        componentOf: variableSet,
                        browseName: "pH.Raw",
                        description: "pH sensor voltage mesaurement endpoint [V]",
                        dataType: DataType.Double,
                        value: {dataType: DataType.Double, value: voltageEndpoint}
                    })
                    AFODictionary.addReferences(pHRaw, AFODictionaryIds.voltage)
                    const referenceBuffer = result.namespace.addVariable({
                        componentOf: variableSet,
                        browseName: "pH.Reference",
                        description: "pH reference buffer value",
                        dataType: DataType.Double,
                        value: {dataType: DataType.Double, value: options.referenceValue}
                    })
                    AFODictionary.addReferences(referenceBuffer, AFODictionaryIds.reference, AFODictionaryIds.pH)
                    const calibrationsValueVariable = result.namespace.addVariable({
                        componentOf: variableSet,
                        browseName: "CalibrationValues",
                        description: "pH sensor calibration values calualted based on reference buffer and endpoint values",
                        dataType: DataType.Double,
                        value: {dataType: DataType.Double, value: calibrationValues, arrayType: VariantArrayType.Array}
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
                    value: {dataType: DataType.String, value: json}
                })
                AFODictionary.addReferences(asm, AFODictionaryIds.measurement_aggregate_document, AFODictionaryIds.pH_monitoring_aggregate_document, ...referenceIds)

            
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
        const properties = propertiesValue===null?[]:(propertiesValue as Variant[]).map(item => { return (<any>item) as LADSProperty })
        const sampleProperty = properties.find(property => (property.key.toLocaleLowerCase().includes("sampleId")))
        const sampleId: string = sampleProperty?sampleProperty.value:"Unknown"
        const sampleInfo: LADSSampleInfo = {containerId: "", sampleId: sampleId, position: "", customData: ""}

        // create options
        this.initCurrentRunOptions(this.findProgramTemplate(ProgramTemplateIds.Measure))
        const options = this.currentRunOptions
        options.properties = properties
        options.samples = [sampleInfo]
        
        this.enterMeasuring()
        return { statusCode: StatusCodes.Good }
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.readyToStart()) return { statusCode: StatusCodes.BadInvalidState }
        const programTemplateId: string = inputArguments[0].value
        const programTemplate = this.programTemplatesElements.find(value => value.identifier.toLowerCase().includes(programTemplateId.toLowerCase()))        
        if (programTemplate) {
            this.initCurrentRunOptions(programTemplate)
            this.runProgram(inputArguments)
            return { 
                outputArguments: [new Variant({ dataType: DataType.String, value: this.currentRunOptions.runId })],
                statusCode: StatusCodes.Good 
            }    
        } else {
            return { statusCode: StatusCodes.BadInvalidArgument }    
        }
    }

    private async runProgram(inputArguments: VariantLike[]) {
        const options = this.currentRunOptions
        options.supervisoryJobId = inputArguments[2].value?inputArguments[2].value:""
        options.supervisoryTaskId = inputArguments[3].value?inputArguments[3].value:""

        // analyze properties
        const propertiesValue = inputArguments[1].value
        options.properties = propertiesValue===null?[]:(propertiesValue as Variant[]).map(item => { return (<any>item) as LADSProperty })

        // analyze samples
        const samplesValue = inputArguments[4].value
        const samples = samplesValue===null?[]:(samplesValue as Variant[]).map(item => { return (<any>item) as LADSSampleInfo })
        if (samples.length === 0) samples.push({containerId: "4711", sampleId: "08150001", position: "1", customData: ""})
        options.samples = samples

        this.enterMeasuring()
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

//---------------------------------------------------------------
// create and start server including a list of viscometers
//---------------------------------------------------------------
export async function main() {
    const server = new pHMeterServerImpl(4841)
    await server.start('/dev/ttyUSB0')
}

main()


