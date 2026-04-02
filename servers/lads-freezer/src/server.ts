// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//---------------------------------------------------------------
// interfaces

import { ApplicationType, assert, CallMethodResultOptions, coerceNodeId, DataType, OPCUAServer, RegisterServerMethod, s, SessionContext, StatusCodes, UAObject, UAStateMachineEx, VariantLike, AddressSpace, Variant, UAVariable, NodeId } from "node-opcua"
import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSCoverFunction, LADSCoverState, LADSDevice, LADSFunctionalState, LADSFunctionalUnit } from "@interfaces"
import { join } from "path"
import { defaultLocation, DIObjectIds, getChildObjects, getStringValue, initComponent, LADSComponentOptions, promoteToFiniteStateMachine, setBooleanValue } from "@utils"

//---------------------------------------------------------------
interface FreezerFunctionSet extends UAObject {
    temperatureSensor: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    door: LADSCoverFunction
}

interface FreezerFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
    functionSet: FreezerFunctionSet
}

interface FreezerFunctionalUnitSet extends UAObject {
    freezerUnit: FreezerFunctionalUnit
}
interface FreezerDevice extends Omit<LADSDevice, "functionalUnitSet"> {
    functionalUnitSet: FreezerFunctionalUnitSet
}

//---------------------------------------------------------------
// Detect capabilities from loaded namespaces
//---------------------------------------------------------------
function detectCapabilitiesFromNamespaces(addressSpace: AddressSpace): string[] {
    const capabilities: string[] = []
    const namespaceArray = addressSpace.getNamespaceArray()

    for (const ns of namespaceArray) {
        const uri = ns.namespaceUri
        // Match OPC Foundation companion specs: http://opcfoundation.org/UA/XXXX/
        if (uri.startsWith('http://opcfoundation.org/UA/') && uri !== 'http://opcfoundation.org/UA/') {
            // Extract capability name from URI (e.g., "LADS" from "http://opcfoundation.org/UA/LADS/")
            const parts = uri.replace('http://opcfoundation.org/UA/', '').split('/')
            const capName = parts[0]
            if (capName && capName.length > 0) {
                capabilities.push(capName)
            }
        }
    }

    return [...new Set(capabilities)] // Deduplicate
}

//---------------------------------------------------------------
// server implmentation
//---------------------------------------------------------------
class FreezerServerImpl {
    server: OPCUAServer
    devices: FreezerDeviceImpl[] = []

    constructor(port: number) {
        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_freezer = join(nodeset_path, 'Freezer.xml')

        try {
            // list of node-set files
            const node_set_filenames = [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_freezer,]

            // build the server object
            const uri = "urn:MOCK930004:NodeOPCUA-Server"
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
                    applicationName: "LADS Freezer",
                    applicationType: ApplicationType.Server,
                    productUri: uri,
                    applicationUri: uri,

                },
                // nodesets used by the server
                nodeset_filename: node_set_filenames,
                // Register with GDS for auto-discovery
                registerServerMethod: RegisterServerMethod.MDNS,
                // discoveryServerEndpointUrl: process.env.GDS_URL || "opc.tcp://localhost:4850",
            })

        }
        catch (err) {
            console.log(err)
        }
    }

    async start() {

        // get objects
        await this.server.initialize()
        const addressSpace = this.server.engine.addressSpace

        // Detect and set capabilities from loaded namespaces
        const capabilities = detectCapabilitiesFromNamespaces(addressSpace)
        console.log(`Detected capabilities: ${capabilities.join(', ')}`)
        // Set capabilities before start() triggers GDS registration
        ;(this.server as any).capabilitiesForMDNS = capabilities

        const nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        const nameSpaceVM = addressSpace.getNamespace("http://spectaris.de/Freezer/")
        assert(nameSpaceVM)
        const freezerDeviceType = nameSpaceVM.findObjectType("FreezerDeviceType")
        assert(freezerDeviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nameSpaceDI.index))
        assert(deviceSet)
        const devices = getChildObjects(deviceSet)
        devices.forEach(device => {
            if (device.typeDefinitionObj === freezerDeviceType) {
                const deviceImpl = new FreezerDeviceImpl(device as FreezerDevice)
                this.devices.push(deviceImpl)
            }
        })

        // finalize start
        await this.server.start()
        const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl;
        console.log(this.server.buildInfo.productName, "is ready on", endpoint);
        console.log("CTRL+C to stop");
    }
}

class FreezerDeviceImpl {
    device: FreezerDevice
    freezerUnit: FreezerUnitImpl

    constructor(device: FreezerDevice) {
        this.device = device
        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: getStringValue(device.manufacturer, "Liebherr"),
            model: getStringValue(device.model, "SUFsg 3501 Mediline"),
            serialNumber: getStringValue(device.serialNumber, "4711"),
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: "My Freezer",
            location: defaultLocation,
        }
        initComponent(device, deviceOptions)
        this.freezerUnit = new FreezerUnitImpl(device.functionalUnitSet.freezerUnit)
        const dT = 500
        setInterval(() => { this.freezerUnit.evaluate(dT) }, dT)
    }
}

class FreezerUnitImpl {
    functionalUnit: FreezerFunctionalUnit
    temperatureSensor: LADSAnalogScalarSensorFunction
    temperatureController: LADSAnalogControlFunction
    door: LADSCoverFunction
    doorStateMachine: UAStateMachineEx
    functionalUnitStateMachine: UAStateMachineEx
    compressorRunning: boolean = false

    constructor(functionalUnit: FreezerFunctionalUnit) {
        this.functionalUnit = functionalUnit
        this.functionalUnitStateMachine = promoteToFiniteStateMachine(functionalUnit.functionalUnitState)
        this.functionalUnitStateMachine.setState(LADSFunctionalState.Running)

        const functionSet = functionalUnit.functionSet

        // temperature sensor and controller
        this.temperatureSensor = functionSet.temperatureSensor
        this.temperatureController = functionSet.temperatureController

        // door state machine and methods
        this.door = functionSet.door
        const stateMachine = this.door.coverState
        this.doorStateMachine = promoteToFiniteStateMachine(stateMachine)
        this.doorStateMachine.setState(LADSCoverState.Closed)
        stateMachine.open.bindMethod(this.open.bind(this))
        stateMachine.close.bindMethod(this.close.bind(this))

        // Enable all functions (LADS default is false)
        setBooleanValue(this.temperatureSensor.isEnabled, true)
        setBooleanValue(this.temperatureController.isEnabled, true)
        setBooleanValue(this.door.isEnabled, true)

        // history
        const sensorValue = this.temperatureSensor.sensorValue
        sensorValue.historizing = true
        functionalUnit.addressSpace.installHistoricalDataNode(sensorValue)

        // Configure alarm limits for temperature sensor
        // Freezer should maintain -20°C, alarm if outside safe range
        this.configureAlarmLimits(this.temperatureSensor, {
            highHighLimit: -10,  // Critical: Freezer way too warm (defrost/failure)
            highLimit: -15,      // Warning: Temperature rising
            lowLimit: -25,       // Warning: Temperature dropping
            lowLowLimit: -30,    // Critical: Freezer too cold (compressor issue)
        })
    }

    /**
     * Configure alarm limits on a sensor function's AlarmMonitor
     *
     * AlarmMonitor is an ExclusiveLevelAlarm (for sensors) with:
     * - HighHighLimit: Critical high threshold
     * - HighLimit: Warning high threshold
     * - LowLimit: Warning low threshold
     * - LowLowLimit: Critical low threshold
     *
     * These optional properties must be explicitly created if they don't exist.
     */
    private configureAlarmLimits(
        sensor: LADSAnalogScalarSensorFunction,
        limits: { highHighLimit?: number; highLimit?: number; lowLimit?: number; lowLowLimit?: number }
    ) {
        const alarmMonitor = sensor.alarmMonitor
        if (!alarmMonitor) {
            console.log(`[AlarmLimits] No AlarmMonitor found on sensor`)
            return
        }

        const addressSpace = this.functionalUnit.addressSpace
        const namespace = addressSpace.getOwnNamespace()

        console.log(`[AlarmLimits] Configuring limits: HH=${limits.highHighLimit}, H=${limits.highLimit}, L=${limits.lowLimit}, LL=${limits.lowLowLimit}`)

        // Helper to get or create a limit property
        const getOrCreateLimit = (name: string, existingVar: UAVariable | undefined): UAVariable => {
            if (existingVar) {
                return existingVar
            }
            // Create the limit variable as a child of AlarmMonitor
            return namespace.addVariable({
                componentOf: alarmMonitor,
                browseName: name,
                dataType: DataType.Double,
                value: new Variant({ dataType: DataType.Double, value: 0 }),
            })
        }

        // Create and set each limit
        if (limits.highHighLimit !== undefined) {
            const limitVar = getOrCreateLimit("HighHighLimit", alarmMonitor.highHighLimit)
            limitVar.setValueFromSource(new Variant({
                dataType: DataType.Double,
                value: limits.highHighLimit
            }))
            console.log(`[AlarmLimits] HighHighLimit set to ${limits.highHighLimit}`)
        }

        if (limits.highLimit !== undefined) {
            const limitVar = getOrCreateLimit("HighLimit", alarmMonitor.highLimit)
            limitVar.setValueFromSource(new Variant({
                dataType: DataType.Double,
                value: limits.highLimit
            }))
            console.log(`[AlarmLimits] HighLimit set to ${limits.highLimit}`)
        }

        if (limits.lowLimit !== undefined) {
            const limitVar = getOrCreateLimit("LowLimit", alarmMonitor.lowLimit)
            limitVar.setValueFromSource(new Variant({
                dataType: DataType.Double,
                value: limits.lowLimit
            }))
            console.log(`[AlarmLimits] LowLimit set to ${limits.lowLimit}`)
        }

        if (limits.lowLowLimit !== undefined) {
            const limitVar = getOrCreateLimit("LowLowLimit", alarmMonitor.lowLowLimit)
            limitVar.setValueFromSource(new Variant({
                dataType: DataType.Double,
                value: limits.lowLowLimit
            }))
            console.log(`[AlarmLimits] LowLowLimit set to ${limits.lowLowLimit}`)
        }
    }

    private async open(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.doorStateMachine.setState(LADSCoverState.Opened)
        return { statusCode: StatusCodes.Good }
    }

    private async close(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.doorStateMachine.setState(LADSCoverState.Closed)
        return { statusCode: StatusCodes.Good }
    }

    evaluate(dT: number) {
        const tAmbient = 25.0 // °C
        const gDoorClosed = 2 // W/K
        const gDoorOpen = 50 // W/K
        const heatCapacity = 5000 // J/K
        const tpv = this.temperatureSensor.sensorValue.readValue().value.value
        const tsp = this.temperatureController.targetValue.readValue().value.value
        const doorIsOpen = this.doorStateMachine.getCurrentState()?.includes(LADSCoverState.Opened)

        // heat tranfer model
        const dtAmbient = tAmbient - tpv
        const gAmbient = doorIsOpen ? gDoorOpen : gDoorClosed
        const qCompressor = this.compressorRunning ? -1000 : 0 // Watt
        const qAmbient = dtAmbient * gAmbient
        const t = tpv + (qCompressor + qAmbient) / heatCapacity * 0.001 * dT
        this.temperatureSensor.sensorValue.setValueFromSource({ dataType: DataType.Double, value: t })
        this.temperatureController.currentValue.setValueFromSource({ dataType: DataType.Double, value: t })

        // 2-poi-t compressor controller
        if (this.compressorRunning) {
            if (tpv <= tsp) {
                this.compressorRunning = false
            }
        } else {
            if ((tpv - tsp) > 5) {
                this.compressorRunning = true
            }
        }
    }
}

export async function main() {
    const serverImpl = new FreezerServerImpl(4842)
    await serverImpl.start()

    // Graceful shutdown - unregister from GDS
    const shutdown = async (signal: string) => {
        console.log(`\n${signal} received, shutting down gracefully...`)
        try {
            await serverImpl.server.shutdown()
            console.log("Server shutdown complete, unregistered from GDS.")
            process.exit(0)
        } catch (err) {
            console.error("Error during shutdown:", err)
            process.exit(1)
        }
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
