// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { readdir, readFile } from 'fs/promises'
import { join, extname } from 'path'
import assert from "assert"
import {
    AccessLevelFlag,
    ApplicationType,
    CallMethodResultOptions,
    DataType,
    DataValue,
    IAddressSpace,
    LocalizedText,
    OPCUAServer,
    ObjectTypeIds,
    SessionContext,
    StatusCode,
    StatusCodes,
    UAEventType,
    UAObject,
    UAStateMachineEx,
    UAVariable,
    Variant,
    VariantArrayType,
    VariantLike,
    coerceNodeId,
} from "node-opcua"

import {
    DIObjectIds,
    LADSComponentOptions,
    LADSDeviceHelper,
    constructNameNodeIdExtensionObject,
    copyProgramTemplate as copyProgramTemplateValues,
    defaultLocation,
    getChildObjects,
    getDescriptionVariable,
    getLADSObjectType,
    getLADSSupportedProperties,
    getStringValue,
    initComponent,
    promoteToFiniteStateMachine,
    raiseEvent,
    sleepMilliSeconds,
    touchNodes,
} from "@utils"

import {
    LADSActiveProgram,
    LADSAnalogControlFunction,
    LADSAnalogScalarSensorFunction,
    LADSBaseControlFunction,
    LADSDevice,
    LADSFunctionalState,
    LADSFunctionalUnit,
    LADSMultiStateDiscreteControlFunction,
    LADSProgramTemplate,
    LADSResult,
    LADSSampleInfo,
} from "@interfaces"
import { EventDataRecorder, VariableDataRecorder, DataExporter } from "@utils"
import { RheometryRecorder, RheometryRecorderOptions } from "@asm"
import { AFODictionary, AFODictionaryIds  } from "@afo"

//---------------------------------------------------------------
// Allotrope Foundation Ontology
//---------------------------------------------------------------
const IncludeAFO = true

//---------------------------------------------------------------
// interfaces
//---------------------------------------------------------------
interface ViscometerFunctionSet extends UAObject {
    speedController: LADSAnalogControlFunction
    temperature: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    relativeTorque: LADSAnalogScalarSensorFunction
    torque: LADSAnalogScalarSensorFunction
    viscosity: LADSAnalogScalarSensorFunction
    shearStress: LADSAnalogScalarSensorFunction
    shearRate: LADSAnalogScalarSensorFunction
    spindle: LADSMultiStateDiscreteControlFunction
}

interface ViscometerFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: ViscometerFunctionSet
}

interface ViscometerFunctionalUnitSet extends UAObject {
    viscometerUnit: ViscometerFunctionalUnit
}
interface ViscometerDevice extends Omit<LADSDevice, "functionalUnitSet"> {
    functionalUnitSet: ViscometerFunctionalUnitSet
}

//---------------------------------------------------------------
// server implmentation
//---------------------------------------------------------------
class ViscometerServerImpl {
    server: OPCUAServer
    devices: ViscometerDeviceImpl[] = []

    constructor(port: number) {
        // provide paths for the nodeset files
        const nodeset_path = join(__dirname, '../../../../nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_viscometer = join(nodeset_path, 'Viscometer.xml')

        try {
            // list of node-set files
            const node_set_filenames = IncludeAFO?[nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_afo, nodeset_viscometer,]:[nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_viscometer,]

            // build the server object
            const uri = "LADS-Viscometer-Server"
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
                    applicationName: "LADS Viscometer",
                    applicationType: ApplicationType.Server,
                    productUri: uri,
                    applicationUri: uri,

                },
                // nodesets used by the server
                nodeset_filename: node_set_filenames,
            })

        }
        catch (err) {
            console.log(err)
        }
    }

    async start(serialPorts: string[]) {
        // get objects
        await this.server.initialize()
        const addressSpace = this.server.engine.addressSpace
        const nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        const nameSpaceVM = addressSpace.getNamespace("http://spectaris.de/Viscometer/")
        assert(nameSpaceVM)
        const deviceType = nameSpaceVM.findObjectType("ViscometerDeviceType")
        assert(deviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nameSpaceDI.index))
        assert(deviceSet)
        serialPorts.forEach((serialPort, index) => {
            const name = serialPorts.length == 1?"myViscometer":`myViscometer${index + 1}`
            const deviceObject = <ViscometerDevice>deviceType.instantiate({
                componentOf: deviceSet,
                browseName: name,
            })
            deviceObject.serialNumber.setValueFromSource({dataType: DataType.String, value: (4711 + index).toString()})
            const deviceImpl = new ViscometerDeviceImpl(deviceObject, serialPort)
            this.devices.push(deviceImpl)
            AFODictionary.addDefaultDeviceReferences(deviceImpl.device)
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
interface SpindleParameters {
    name: string
    code: number
    smc: number
    src: number
}

const Spindles: SpindleParameters[] = [
    {name: "RV1", code: 1, smc: 1, src: 0},
    {name: "RV2", code: 2, smc: 4, src: 0},
    {name: "RV3", code: 3, smc: 10, src: 0},
    {name: "RV4", code: 4, smc: 20, src: 0},
    {name: "RV5", code: 5, smc: 40, src: 0},
    {name: "RV6", code: 6, smc: 100, src: 0},
    {name: "RV7", code: 7, smc: 400, src: 0},
    {name: "HA1", code: 1, smc: 1, src: 0},
    {name: "HA2", code: 2, smc: 4, src: 0},
    {name: "HA3", code: 3, smc: 10, src: 0},
    {name: "HA4", code: 4, smc: 20, src: 0},
    {name: "HA5", code: 5, smc: 40, src: 0},
    {name: "HA6", code: 6, smc: 100, src: 0},
    {name: "HA7", code: 7, smc: 400, src: 0},
    {name: "HB1", code: 1, smc: 1, src: 0},
    {name: "HB2", code: 2, smc: 4, src: 0},
    {name: "HB3", code: 3, smc: 10, src: 0},
    {name: "HB4", code: 4, smc: 20, src: 0},
    {name: "HB5", code: 5, smc: 40, src: 0},
    {name: "HB6", code: 6, smc: 100, src: 0},
    {name: "HB7", code: 7, smc: 400, src: 0},
    {name: "DIN81", code: 81, smc: 3.7, src: 1.29},
    {name: "DIN82", code: 82, smc: 3.75, src: 1.29},
    {name: "DIN83", code: 83, smc: 12.09, src: 1.29},
    {name: "DIN85", code: 85, smc: 1.22, src: 1.29},
    {name: "DIN86", code: 86, smc: 3.65, src: 1.29},
    {name: "DIN87", code: 87, smc: 12.13, src: 1.29},
    {name: "SC4-14", code: 14, smc: 125, src: 0.4},
    {name: "SC4-15", code: 15, smc: 50, src: 0.48},
    {name: "SC4-16", code: 16, smc: 128, src: 0.29},
    {name: "SC4-18", code: 18, smc: 3.2, src: 1.32},
    {name: "SC4-21", code: 21, smc: 5, src: 0.93},
    {name: "SC4-25", code: 25, smc: 512, src: 0.22},
    {name: "SC4-27", code: 27, smc: 125, src: 0.4},
    {name: "SC4-28", code: 28, smc: 50, src: 0.28},
    {name: "SC4-29", code: 29, smc: 100, src: 0.25},
    {name: "SC4-31", code: 31, smc: 32, src: 0.34},
    {name: "SC4-34", code: 34, smc: 64, src: 0.28},
]

interface ModelParameters { name: string, tk: number, code: string}

const Models: ModelParameters[] = [
    {name: "LVDV-II+", tk: 0.09373, code: "LV"},
    {name: "2.5LVDV-II+", tk: 0.2343, code: "2.5 LV"},
    {name: "5LVDV-II+", tk: 0.4686, code: "5 LV"},
    {name: "1/4 RVDV-II+", tk: 0.25, code: "0.25 RV"},
    {name: "1/2 RVDV-II+", tk: 0.5, code: "0.5 RV"},
    {name: "RVDV-II+", tk: 1.0, code: "RV"},
    {name: "HADV-II+", tk: 2.0, code: "HA"},
    {name: "2HADV-II+", tk: 4.0, code: "2 HA"},
    {name: "2.5HADV-II+", tk: 5.0, code: "2.5 HA"},
    {name: "HBDV-II+", tk: 8.0, code: "HB"},
    {name: "2HBDV-II+", tk: 16.0, code: "2 HB"},
    {name: "2.5HBDV-II+", tk: 20.0, code: "2.5 HB"},
]

class ViscometerDeviceImpl {
    addressSpace: IAddressSpace
    baseEventType: UAEventType
    device: ViscometerDevice
    viscometerUnitImpl: ViscometerUnitImpl

    constructor(device: ViscometerDevice, serialPort: string) {
        this.device = device
        const name = this.device.getDisplayName()
        console.log(`Initializing viscometer device ${name}..`)

        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: getStringValue(device.manufacturer, "Brookfield Engineering"),
            model: getStringValue(device.model, "LVDV-II+"),
            serialNumber: getStringValue(device.serialNumber, "4711"),
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: `My ${name}`,
            location: defaultLocation,
        }
        initComponent(device, deviceOptions)
        
        // initialize device
        const deviceHelper = new LADSDeviceHelper(this.device, {initializationTime: 2000, shutdownTime: 2000, raiseEvents: true})
        this.addressSpace = this.device.addressSpace
        this.baseEventType = this.addressSpace.findEventType(coerceNodeId(ObjectTypeIds.BaseEventType))
        const viscometerUnit = this.device.functionalUnitSet.viscometerUnit
        assert(viscometerUnit)
        this.viscometerUnitImpl = new ViscometerUnitImpl(this, viscometerUnit)

        // Allotrope Fpindation Ontologoes
        AFODictionary.addReferences(device, AFODictionaryIds.measurement_device, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
    }
}

//---------------------------------------------------------------
// viscometer program definitions
//---------------------------------------------------------------
const DataDirectory = join(__dirname, "data")

interface ViscometerProgram {
    name: string
    author: string
    description: string
    created?: Date
    modified?: Date
    steps: VisometerProgramStep[]
}

interface VisometerProgramStep {
    name: string
    dt: number
    nsp: number
    tsp: number
}

// Type guard
function isViscometerProgram(obj: any): obj is ViscometerProgram {
    return (
        typeof obj === 'object' &&
        typeof obj.name === 'string' &&
        typeof obj.author === 'string' &&
        typeof obj.description === 'string' &&
        Array.isArray(obj.steps) &&
        obj.steps.every(isVisometerProgramStep)
    )
}

function isVisometerProgramStep(obj: any): obj is VisometerProgramStep {
    return (
        typeof obj === 'object' &&
        typeof obj.name === 'string' &&
        typeof obj.dt === 'number' &&
        typeof obj.nsp === 'number' &&
        typeof obj.tsp === 'number'
    )
}

// Async Loader
export async function loadViscometerProgramsFromDirectory(directory: string): Promise<ViscometerProgram[]> {
    const programs: ViscometerProgram[] = []

    function checkAndPushProgram(parsed: any) {
        if (isViscometerProgram(parsed)) {
            programs.push(parsed)
        } else {
            console.warn(`Invalid schema: ${parsed}`)
        }
    }

    try {
        const files = await readdir(directory)
        for (const file of files) {
            if (extname(file).toLowerCase() === '.json') {
                const filePath = join(directory, file)
                try {
                    const content = await readFile(filePath, 'utf-8')
                    const parsed = JSON.parse(content)
                    // a json file could include one or a list of programs
                    if (Array.isArray(parsed)) {
                        parsed.forEach(value => checkAndPushProgram(value))
                    } else {
                        checkAndPushProgram(parsed)
                    }
                } catch (err) {
                    console.error(`Failed to load file: ${file}`, err)
                }
            }
        }
    }
    catch(err) {
        console.warn(`Viscometer program directory does not exist ${directory}.`)
    }

    return programs
}

const DefaultViscometerPrograms: ViscometerProgram[] = [
    {
        name: "Analytical Method A (30rpm)",
        author: "AixEngineers",
        description: "",
        steps: [
            {name: "Viscosity 30°C", dt: 10000, tsp: 30, nsp: 30},
            {name: "Viscosity 40°C", dt: 10000, tsp: 40, nsp: 30},
            {name: "Viscosity 50°C", dt: 10000, tsp: 50, nsp: 30},
            {name: "Viscosity 60°C", dt: 10000, tsp: 60, nsp: 30},
            {name: "Viscosity 80°C", dt: 10000, tsp: 80, nsp: 30},
            {name: "Viscosity 100°C", dt: 10000, tsp: 100, nsp: 30},
        ]
    },
    {
        name: "Analytical Method B (50rpm)",
        author: "AixEngineers",
        description: "",
        steps: [
            {name: "Viscosity 30°C", dt: 10000, tsp: 30, nsp: 50},
            {name: "Viscosity 40°C", dt: 10000, tsp: 40, nsp: 50},
            {name: "Viscosity 50°C", dt: 10000, tsp: 50, nsp: 50},
            {name: "Viscosity 60°C", dt: 10000, tsp: 60, nsp: 50},
            {name: "Viscosity 80°C", dt: 10000, tsp: 80, nsp: 50},
            {name: "Viscosity 100°C", dt: 10000, tsp: 100, nsp: 50},
        ]
    },
    {
        name: "Analytical Method C (short)",
        author: "AixEngineers",
        description: "",
        steps: [
            {name: "Viscosity 30°C", dt: 10000, tsp: 30, nsp: 50},
        ]
    },
]

//---------------------------------------------------------------
// functional unit implementation
//---------------------------------------------------------------
class ViscometerUnitImpl {
    parent: ViscometerDeviceImpl
    functionalUnit: ViscometerFunctionalUnit
    functionalUnitState: UAStateMachineEx
    speedController: LADSAnalogControlFunction
    speedControllerState: UAStateMachineEx
    temperature: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    temperatureControllerState: UAStateMachineEx
    relativeTorque: LADSAnalogScalarSensorFunction
    torque: LADSAnalogScalarSensorFunction
    viscosity: LADSAnalogScalarSensorFunction
    shearStress: LADSAnalogScalarSensorFunction
    shearRate: LADSAnalogScalarSensorFunction
    model: ModelParameters
    spindle: SpindleParameters
    // simulation
    viscosity_0: UAVariable
    alpha: UAVariable    
    n: UAVariable
    // program manager
    viscometerPrograms: ViscometerProgram[]
    programTemplates: LADSProgramTemplate[] = []
    activeProgram: LADSActiveProgram
    results: LADSResult[] = []

    constructor(parent: ViscometerDeviceImpl, functionalUnit: ViscometerFunctionalUnit) {
        this.parent = parent
        this.functionalUnit = functionalUnit
        const addressSpace = functionalUnit.addressSpace
        const functionSet = this.functionalUnit.functionSet

        // set model
        this.model = Models[0]

        // initialize spindle list
        this.initSpindle()

        // intialize speed controller
        this.initSpeedController()

        // intialize temperature controller
        this.initTemperatureController()

        // initialize viscosity with history
        this.viscosity = functionSet.viscosity
        const viscosityValue = this.viscosity.sensorValue
        viscosityValue.historizing = true
        addressSpace.installHistoricalDataNode(viscosityValue)
        // initialize other functions
        this.relativeTorque = functionSet.relativeTorque
        this.torque = functionSet.torque
        this.shearStress = functionSet.shearStress
        this.shearRate = functionSet.shearRate
        this.temperature = functionSet.temperature
        this.temperature.sensorValue.setValueFromSource({dataType: DataType.Double, value: 25.0})

        // add Allotrope Ontology References
        AFODictionary.addReferences(this.functionalUnit, AFODictionaryIds.measurement_device, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
        AFODictionary.addSensorFunctionReferences(this.viscosity, AFODictionaryIds.viscosity)
        AFODictionary.addSensorFunctionReferences(this.relativeTorque, AFODictionaryIds.relative_intensity)
        AFODictionary.addSensorFunctionReferences(this.torque, AFODictionaryIds.torque)
        AFODictionary.addSensorFunctionReferences(this.shearStress, AFODictionaryIds.shear_stress_of_quality)
        AFODictionary.addSensorFunctionReferences(this.shearRate, AFODictionaryIds.rate)
        AFODictionary.addSensorFunctionReferences(this.temperature, AFODictionaryIds.temperature_measurement, AFODictionaryIds.temperature)
        AFODictionary.addControlFunctionReferences(this.temperatureController, AFODictionaryIds.temperature_controller, AFODictionaryIds.temperature)
        AFODictionary.addControlFunctionReferences(this.speedController, AFODictionaryIds.rotational_speed, AFODictionaryIds.rotational_speed)

        // future - initialize program mananger
        this.initProgramManager()

        // simulation
        const namespace = this.functionalUnit.namespace
        const simulator = namespace.addObject({
            componentOf: this.functionalUnit,
            browseName: "Simulator",
            description: "Viscositiy simulation with temperataue and shearforce dependencies."
        })
        this.viscosity_0 = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated Viscosity",
            description: "Viscosity at temperature 25°C and shear rate 1/s",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 622.8 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })
        this.alpha = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated Alpha",
            description: "Temperature coefficient for viscosity [%/K]",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 0.01 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })
        this.n = namespace.addVariable({
            componentOf: simulator,
            browseName: "Simulated N",
            description: "Flow behavior index according to power law model. N = 1 : no shear rate dependency; N > 1: shear thickening, dilatant; 0 < N < 1 : shear thinning, pseudo-plastic",
            dataType: DataType.Double,
            value: {dataType: DataType.Double, value: 0.95 },
            accessLevel: AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        })

        // start run loop
        const dT = 200 
        setInterval( () => {this.evaluate(dT)}, dT)
    }

    private evaluate(dT: number) {

        // temperature controller
        const tpv = this.evaluateTemperatureController(dT)

        // speed controller
        const npv = this.evaluateSpeedController(dT)

        // temperature sensor
        const cf = dT / 5000
        const temperature = cf * tpv + (1.0 - cf) * Number(this.temperature.sensorValue.readValue().value.value)
        this.temperature.sensorValue.setValueFromSource({dataType: DataType.Double, value: temperature})

        // shear rate
        const shearRate = npv * this.spindle.src
        this.shearRate.sensorValue.setValueFromSource({dataType: DataType.Double, value: shearRate})

        // simulated viscosity
        const viscosity_0 = this.viscosity_0.readValue().value.value  // viscosity at 25°C and 1/s
        const alpha = this.alpha.readValue().value.value
        const n = this.n.readValue().value.value
        const viscosity_t = viscosity_0 / (1.0 + alpha * (tpv - 25.0)) // temperature dependency
        const viscosity_pv = shearRate > 0?viscosity_t * Math.pow(shearRate, n - 1):viscosity_t // shear dependency

        // resulting torque
        const noise =  0.002 * (Math.random() - 0.5)
        const relativeTorque = viscosity_pv * npv / 100.0 / (this.model.tk * this.spindle.smc) + noise
        this.relativeTorque.sensorValue.setValueFromSource({dataType: DataType.Double, value: relativeTorque})
        const torque = 1000.0 * this.model.tk * (relativeTorque / 100.0) // absolute toreque in mNm
        this.torque.sensorValue.setValueFromSource({dataType: DataType.Double, value: torque})

        // measured viscosity
        const valid = npv > 0.01
        const statusCode = valid?StatusCodes.Good:StatusCodes.UncertainLastUsableValue
        const viscosity = valid?100.0 / npv * this.model.tk * this.spindle.smc * relativeTorque + noise:this.viscosity.sensorValue.readValue().value.value
        this.viscosity.sensorValue.setValueFromSource({dataType: DataType.Double, value: viscosity}, statusCode)

        // shear stress
        const shearStress = this.model.tk * this.spindle.src * this.spindle.smc * relativeTorque
        this.shearStress.sensorValue.setValueFromSource({dataType: DataType.Double, value: shearStress})
    }

    private startController(controller: LADSBaseControlFunction, stateMachine: UAStateMachineEx, withEvent: boolean): StatusCode {
        const currentState = stateMachine.getCurrentState();
        if (currentState.includes(LADSFunctionalState.Running)) {
            return StatusCodes.BadInvalidState
        }
        stateMachine.setState(LADSFunctionalState.Running)
        if (withEvent) {
            raiseEvent(controller, `${controller.getDisplayName()} started`)
        }

    }
    
    private stopController(controller: LADSBaseControlFunction, stateMachine: UAStateMachineEx, withEvent: boolean): StatusCode {
        const currentState = stateMachine.getCurrentState();
        if (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Stopping)) {
            return StatusCodes.BadInvalidState
        }
        stateMachine.setState(LADSFunctionalState.Stopped)
        if (withEvent) {
            raiseEvent(controller, `${controller.getDisplayName()} stopped`)
        }

    }
    
    // speed controller
    private initSpeedController() {
        this.speedController = this.functionalUnit.functionSet.speedController
        assert(this.speedController)
        const stateMachine = this.speedController.controlFunctionState
        stateMachine.start?.bindMethod(this.startSpeedController.bind(this))
        stateMachine.stop?.bindMethod(this.stopSpeedController.bind(this))
        this.speedControllerState = promoteToFiniteStateMachine(stateMachine)
        this.speedControllerState.setState(LADSFunctionalState.Stopped)
        this.speedController.currentValue.setValueFromSource({dataType: DataType.Double, value: 0.0})
        this.speedController.targetValue.setValueFromSource({dataType: DataType.Double, value: 30.0})
        this.speedController.targetValue.on("value_changed", (dataValue => {raiseEvent(this.speedController, `Speed set-point changed to ${dataValue.value.value}rpm`)}))
    }

    private async startSpeedController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.startController(this.speedController, this.speedControllerState, true) }
    }

    private async stopSpeedController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.stopController(this.speedController, this.speedControllerState, true) }
    }

    private evaluateSpeedController(dT: number): number {
        function calcSpeed(sp: number, pv: number):  number {
            const delta = 0.001 * dT * 10 // 10rpm/s
            if (Math.abs(sp - pv) < delta) {
                return sp
            } else if (pv < sp) {
                return pv + delta
            } else {
                return pv - delta
            }
        }

        const running =  this.speedControllerState.getCurrentState().includes(LADSFunctionalState.Running)
        const sp = this.speedController.targetValue.readValue().value.value
        const pv = this.speedController.currentValue.readValue().value.value
        const newpv = running?calcSpeed(sp, pv):0
        this.speedController.currentValue.setValueFromSource({dataType: DataType.Double, value: newpv})
        return newpv
    }

    // temperature controller
    private initTemperatureController() {
        const controller = this.functionalUnit.functionSet.temperatureController
        assert(controller)
        this.temperatureController = controller
        const stateMachine = this.temperatureController.controlFunctionState
        stateMachine.start?.bindMethod(this.startTemperatureController.bind(this))
        stateMachine.stop?.bindMethod(this.stopTemperatureController.bind(this))
        this.temperatureControllerState = promoteToFiniteStateMachine(stateMachine)
        this.temperatureControllerState.setState(LADSFunctionalState.Stopped)
        controller.currentValue.setValueFromSource({dataType: DataType.Double, value: 25.0})
        controller.currentValue.historizing = true
        controller.addressSpace.installHistoricalDataNode(controller.currentValue)
        controller.targetValue.setValueFromSource({dataType: DataType.Double, value: 50.0})
        controller.targetValue.on("value_changed", (dataValue => {raiseEvent(this.temperatureController, `Temperature set-point changed to ${dataValue.value.value}°C`)}))
    }

    private async startTemperatureController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.startController(this.temperatureController, this.temperatureControllerState, true) }
    }

    private async stopTemperatureController(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return { statusCode: this.stopController(this.temperatureController, this.temperatureControllerState, true) }
    }

    private evaluateTemperatureController(dT: number): number {

        const running =  this.temperatureControllerState.getCurrentState().includes(LADSFunctionalState.Running)
        const sp = running?this.temperatureController.targetValue.readValue().value.value:25
        const pv = this.temperatureController.currentValue.readValue().value.value
        const noise = 0.02 * (Math.random() - 0.5)
        const cf = running?dT / 2000:dT / 10000
        const newpv = (cf * sp) + (1.0 - cf) * pv + noise
        this.temperatureController.currentValue.setValueFromSource({dataType: DataType.Double, value: newpv})
        return newpv
    }

    // viscometer system
    private startViscometer(): StatusCode {
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted)))) {
            return StatusCodes.BadInvalidState
        }
        this.functionalUnitState.setState(LADSFunctionalState.Running)
        this.startController(this.speedController, this.speedControllerState, false)
        this.startController(this.temperatureController, this.temperatureControllerState, false)
        raiseEvent(this.functionalUnit, `Viscometer started with speed set-point ${this.speedController.targetValue.readValue().value.value}rpm`)
        return StatusCodes.Good
    }

    private stopViscometer(): StatusCode {  
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && currentState.includes(LADSFunctionalState.Running))) {
            return StatusCodes.BadInvalidState
        }
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
        this.stopController(this.speedController, this.speedControllerState, false)
        this.stopController(this.temperatureController, this.temperatureControllerState, false)
        raiseEvent(this.functionalUnit, "Viscometer stopped")
        return StatusCodes.Good
    }

    // spindle
    private initSpindle() {
        const names = Spindles.map(spindle => new LocalizedText({text: spindle.name}) )
        const codes = Spindles.map(spindle => new LocalizedText({text: (spindle.code < 10)?`0${spindle.code}`:`${spindle.code}`}))
        const spindle = this.functionalUnit.functionSet.spindle
        spindle.targetValue.enumStrings.setValueFromSource({dataType: DataType.LocalizedText, arrayType: VariantArrayType.Array, value: names})
        spindle.currentValue.enumStrings.setValueFromSource({dataType: DataType.LocalizedText, arrayType: VariantArrayType.Array, value: codes})
        const index = Spindles.findIndex(spindle => (spindle.name == "SC4-31"))
        const value = index >= 0?index:0
        spindle.targetValue.on("value_changed", this.setCurrentSpindle.bind(this))
        spindle.targetValue.setValueFromSource({dataType: DataType.UInt32, value: value})
    }

    private setCurrentSpindle(dataValue: DataValue) {
        const index = Number(dataValue.value.value)
        this.functionalUnit.functionSet.spindle.currentValue.setValueFromSource({dataType: DataType.UInt32, value: index})
        this.spindle = Spindles[index]
        raiseEvent(this.functionalUnit, `Spindle changed to type ${this.spindle.name} w/ code ${this.spindle.code}`)
    }
    
    //---------------------------------------------------------------
    // program manager implementation
    //---------------------------------------------------------------
    private initProgramManager() {
        const stateMachine = this.functionalUnit.functionalUnitState
        stateMachine.startProgram?.bindMethod(this.startProgram.bind(this))
        stateMachine.stop?.bindMethod(this.stopProgram.bind(this))
        stateMachine.abort?.bindMethod(this.abortProgram.bind(this))
        this.functionalUnitState = promoteToFiniteStateMachine(stateMachine)
        this.functionalUnitState.setState(LADSFunctionalState.Stopped)
        this.activeProgram = this.functionalUnit.programManager?.activeProgram
        this.programTemplates = <LADSProgramTemplate[]>getChildObjects(this.functionalUnit.programManager?.programTemplateSet as UAObject)
        this.results = <LADSResult[]><unknown>getChildObjects(this.functionalUnit.programManager?.resultSet as UAObject)
        this.initProgramTemplates()
    }

    private async initProgramTemplates(){
        // build some fake program templates
        const programTemplateType = getLADSObjectType(this.parent.addressSpace, "ProgramTemplateType")
        const programTemplateSetNode = <UAObject>this.functionalUnit.programManager?.programTemplateSet
        if (!programTemplateSetNode) return
        const loadedViscometerPrograms = await loadViscometerProgramsFromDirectory(join(DataDirectory, "programs"))
        this.viscometerPrograms = loadedViscometerPrograms.length > 0?loadedViscometerPrograms:DefaultViscometerPrograms
        const programTemplateNames: string[] = this.viscometerPrograms.map(value => {return value.name})
        programTemplateNames.forEach((name, index) => {
            const programTemplate = <LADSProgramTemplate>programTemplateType.instantiate({ 
                componentOf: programTemplateSetNode,
                browseName: name,
            })
            const viscometerProgram = this.viscometerPrograms[index]
            const description = getDescriptionVariable(programTemplate)
            this.programTemplates.push(programTemplate)
            programTemplate.author.setValueFromSource({dataType: DataType.String, value: viscometerProgram.author })
            programTemplate.deviceTemplateId.setValueFromSource({dataType: DataType.String, value: name })
            description.setValueFromSource({dataType: DataType.LocalizedText, value: viscometerProgram.description })
            viscometerProgram.created?programTemplate.created.setValueFromSource({dataType: DataType.DateTime, value: new Date(viscometerProgram.created)}):0
            viscometerProgram.modified?programTemplate.modified.setValueFromSource({dataType: DataType.DateTime, value: new Date(viscometerProgram.modified)}):0

            // Allotrope Foundation Ontology
            AFODictionary.addDefaultProgramTemplateReferences(programTemplate)
            AFODictionary.addReferences(programTemplate, AFODictionaryIds.measurement_method, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
        })
    }

    private async startProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        // validate current state
        const currentState = this.functionalUnitState.getCurrentState();
        if (!(currentState && (currentState.includes(LADSFunctionalState.Stopped) || currentState.includes(LADSFunctionalState.Aborted)))) {
            return { statusCode: StatusCodes.BadInvalidState }
        }

        // valdate input arguments
        const template = this.findProgramTemplate(inputArguments[0].value)
        const programTemplate = template?template:this.programTemplates[0]
        const programTemplateId = programTemplate.browseName.name
        const startedTimestamp = new Date()
        const iso = startedTimestamp.toISOString()
        const date = iso.slice(0, 10).replace(/-/g, "")
        const time = iso.slice(11, 19).replace(/:/g, "")
        const deviceProgramRunId = `${date}-${time}-${programTemplateId.replace(/[ (),°]/g,"")}`

        /*for (const inputArgumentIndex in inputArguments) {
            const inputArgument = inputArguments[inputArgumentIndex];
            // TODO validate argument at position index
            const validationFailed = false
            if (validationFailed) return { statusCode: StatusCodes.BadInvalidArgument }
        }*/

        // initiate program run (async)
        this.runProgram(deviceProgramRunId, startedTimestamp, inputArguments)

        // return run-Id
        return {
            outputArguments: [new Variant({ dataType: DataType.String, value: deviceProgramRunId })],
            statusCode: StatusCodes.Good
        }
    }

    private findProgramTemplate(name: string): LADSProgramTemplate {
        const programTemplate = this.programTemplates.find((template) => (template.browseName.name == name))
        return programTemplate
    }

    private async stopProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return this.stopOrAbortProgram(LADSFunctionalState.Stopping, LADSFunctionalState.Stopped)
    }

    private async abortProgram(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        return this.stopOrAbortProgram(LADSFunctionalState.Aborting, LADSFunctionalState.Aborted)
    }

    private async stopOrAbortProgram(transitiveState: string, finalState: string) {
        const stateMachine = this.functionalUnitState
        const currentState = stateMachine.getCurrentState();
        if (!(currentState && currentState.includes(LADSFunctionalState.Running))) return { statusCode: StatusCodes.BadInvalidState }
        stateMachine.setState(transitiveState)
        sleepMilliSeconds(500).then(() => stateMachine.setState(finalState))
        return { statusCode: StatusCodes.Good }
    }

    private async runProgram(deviceProgramRunId: string, startedTimestamp: Date, inputArguments: VariantLike[]) {
        // dynamically create an new result object in the result set and update node-version attribute
        const resultType = getLADSObjectType(this.parent.addressSpace, "ResultType")
        const resultSetNode = <UAObject>this.functionalUnit.programManager.resultSet
        const result = <LADSResult><unknown>resultType.instantiate({ 
            componentOf: resultSetNode,
            browseName: deviceProgramRunId, 
            optionals: ["NodeVersion", "VariableSet.NodeVersion"] 
        })
        touchNodes(resultSetNode)

        // get program template-id
        const activeProgram = this.activeProgram
        const programTemplateId: string = inputArguments[0].value
        const programTemplate = this.findProgramTemplate(programTemplateId)
        if (programTemplate) {
            const value = constructNameNodeIdExtensionObject(
                this.parent.addressSpace,
                programTemplateId, 
                programTemplate.nodeId 
            )
            activeProgram?.currentProgramTemplate?.setValueFromSource({
                dataType: DataType.ExtensionObject, 
                value: value,
            })
        }
        const program: ViscometerProgram = programTemplate?this.viscometerPrograms.find((program) => (programTemplate.browseName.name.includes(program.name))):this.viscometerPrograms[0]

        // scan supported properties
        const properties = inputArguments[1]
        if (properties?.arrayType === VariantArrayType.Array) {
            const keyVariables = getLADSSupportedProperties(this.functionalUnit)
            const keyValues = properties.value as Variant[]
            keyValues?.forEach((item) =>{
                try {
                    const keyValue: {key: string, value: string} = <any>item
                    const property = keyVariables.find(keyVariable => (keyVariable.key == keyValue.key))
                    if (property) {
                        const variable = property.variable
                        const dataType = variable.dataTypeObj
                        variable.setValueFromSource({dataType: dataType.browseName.name , value: keyValue.value})
                    }
                }
                catch(err) {
                    console.log(err)
                }
            })
        }

        // scan samples
        const samples: LADSSampleInfo[] = []
        const samplesArguments = inputArguments[4]
        if (samplesArguments.value != null ) {
            try {
                const samplesInfo = samplesArguments.value as Variant[]
                samplesInfo?.forEach((item) => {
                    const sampleInfo: LADSSampleInfo = <any>item
                    samples.push(sampleInfo)
                })
            }
            catch(err) {
                console.log(err)
            }
        } else {
            // create fake samples
            samples.push({containerId: "4711", sampleId: "08150001", position: "1", customData: ""})
        }
        
        // set context information provided by input-arguments
        getDescriptionVariable(result).setValueFromSource({dataType: DataType.LocalizedText, value: `Run based on template ${programTemplateId}, started ${startedTimestamp.toLocaleDateString()}.`})
        result.properties?.setValueFromSource(inputArguments[1])
        result.supervisoryJobId?.setValueFromSource(inputArguments[2])
        result.supervisoryTaskId?.setValueFromSource(inputArguments[3])
        result.samples?.setValueFromSource(inputArguments[4])
        result.started?.setValueFromSource({ dataType: DataType.DateTime, value: startedTimestamp })
        copyProgramTemplateValues(programTemplate, result.programTemplate)

        // Allotrope Foundation Ontology
        AFODictionary.addDefaultResultReferences(result)
        AFODictionary.addReferences(result, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
        AFODictionary.addReferences(result.programTemplate, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)

        // initialize active-program runtime properties
        const steps = program.steps
        const estimatedRuntime = steps.reduce((time, step) => time + step.dt, 0)
        activeProgram.currentRuntime?.setValueFromSource({ dataType: DataType.Double, value: 0 })
        activeProgram.estimatedRuntime?.setValueFromSource({ dataType: DataType.Double, value: estimatedRuntime })
        activeProgram.estimatedStepNumbers?.setValueFromSource({ dataType: DataType.UInt32, value: steps.length })
        activeProgram.deviceProgramRunId?.setValueFromSource({ dataType: DataType.String, value: deviceProgramRunId })

        // create recorders
        const endPointRecorder = new VariableDataRecorder("End-points", [
            activeProgram.currentStepName, this.temperature.sensorValue, this.viscosity.sensorValue, this.shearStress.sensorValue, this.shearRate.sensorValue, 
            this.relativeTorque.sensorValue, this.torque.sensorValue, this.speedController.currentValue, this.temperatureController.currentValue
        ])
        const trendRecorder = new VariableDataRecorder("Trends", [this.temperature.sensorValue, this.viscosity.sensorValue, ])
        const trendRecorderInterval = setInterval(() => {trendRecorder.createRecord()}, 1000)
        const eventRecorder = new EventDataRecorder("Events", this.functionalUnit)

        const rheometryRecorderOptions: RheometryRecorderOptions = {
            result: result,
            devices: [{deviceType: "Viscometer", device: this.parent.device}],
            runtime: this.activeProgram.currentRuntime,
            stepRuntime: this.activeProgram.currentStepRuntime,
            shearRate: this.shearRate.sensorValue,
            shearStress: this.shearStress.sensorValue,
            viscosity: this.viscosity.sensorValue,
            torque: this.torque.sensorValue,
            temperature: this.temperature.sensorValue,
            sample: samples[0],
        }
        const rheometryRecorder = new RheometryRecorder(rheometryRecorderOptions)

        // start everything
        this.startViscometer()
        raiseEvent(this.functionalUnit, `Starting run ${deviceProgramRunId}`)
        const tsRuntime = Date.now()
        for (let index = 0; index < steps.length; index++) {
            const step = steps[index]
            raiseEvent(this.functionalUnit, `Starting step ${step.name}`)
            // set step specific information
            activeProgram.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: step.name })
            activeProgram.currentStepNumber?.setValueFromSource({ dataType: DataType.UInt32, value: index + 1 })
            activeProgram.currentStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: 0 })
            activeProgram.estimatedStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: step.dt })

            // set target-values
            this.speedController.targetValue.setValueFromSource({dataType: DataType.Double, value: step.nsp})
            this.temperatureController.targetValue.setValueFromSource({dataType: DataType.Double, value: step.tsp})

            // wait and update
            const tsStepRuntime = Date.now()
            const updateInterval = setInterval(() => { 
                const now = Date.now()
                activeProgram.currentRuntime?.setValueFromSource({ dataType: DataType.Double, value: now - tsRuntime })
                activeProgram.currentStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: now - tsStepRuntime })
            }, 200)
            await sleepMilliSeconds(step.dt)
            clearInterval(updateInterval)

            // record end-points
            const endPointRecord = endPointRecorder.createRecord()
            const endPointVariables = endPointRecord.createResultVariables(step.name, result.variableSet)
            AFODictionary.addReferences(endPointVariables, AFODictionaryIds.recording)
            rheometryRecorder.createRecord()
            touchNodes(result, result.variableSet)
        
            // check if run was stopped or aborted from remote
            const currentState  = this.functionalUnitState.getCurrentState()
            if (currentState && !currentState.includes(LADSFunctionalState.Running)) { 
                raiseEvent(this.functionalUnit, `Run ${deviceProgramRunId} aborted`)
                break 
            }
        }

        // finalize
        //console.log(resultRecorder.createCSVString())
        result.stopped?.setValueFromSource({ dataType: DataType.DateTime, value: new Date() })
        this.stopViscometer()
        clearInterval(trendRecorderInterval)

        // creat files
        const resultsDirectory = join(DataDirectory, "results")
        new DataExporter().writeXSLXResultFile(result.fileSet, "XLSX",resultsDirectory, deviceProgramRunId, [endPointRecorder, trendRecorder, eventRecorder])        
        const model = rheometryRecorder.createModel()
        rheometryRecorder.writeResultFile(result.fileSet, "ASM", resultsDirectory, deviceProgramRunId, model)
         
        // finally represent ASM model as JSON string in VariableSet
        const jsonModel = result.namespace.addVariable({
            componentOf: result.variableSet,
            browseName: "ASM",
            description: "Result as Allotrope Simple Model (ASM) in JSON format.",
            dataType: DataType.String,
            value: {dataType: DataType.String, value: JSON.stringify(model, null, 2)},
            accessLevel: AccessLevelFlag.CurrentRead
        })
        AFODictionary.addReferences(jsonModel, AFODictionaryIds.ASM_file, AFODictionaryIds.rheometry_aggregate_document)
        
        // update node version of resultset
        touchNodes(result, result.fileSet, result.variableSet)
    }
}

//---------------------------------------------------------------
// create and start server including a list of viscometers
//---------------------------------------------------------------
export async function main() {
    const server = new ViscometerServerImpl(4840)
    await server.start(['/dev/ttyUSB0', '/dev/ttyUSB1'])
}

main()
