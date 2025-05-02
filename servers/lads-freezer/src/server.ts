//---------------------------------------------------------------
// interfaces

import { ApplicationType, assert, CallMethodResultOptions, coerceNodeId, DataType, OPCUAServer, s, SessionContext, StatusCodes, UAObject, UAStateMachineEx, VariantLike } from "node-opcua"
import { LADSAnalogControlFunction, LADSAnalogScalarSensorFunction, LADSCoverFunction, LADSCoverState, LADSDevice, LADSFunctionalState, LADSFunctionalUnit } from "@interfaces"
import { join } from "path"
import { defaultLocation, DIObjectIds, getChildObjects, getStringValue, initComponent, LADSComponentOptions, promoteToFiniteStateMachine } from "@utils"

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
// server implmentation
//---------------------------------------------------------------
class FreezerServerImpl {
    server: OPCUAServer
    devices: FreezerDeviceImpl[] = []

    constructor(port: number) {
        // provide paths for the nodeset files
        const nodeset_path = join(__dirname, '../../../../nodesets')
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
            const uri = "LADS-Freezer-Server"
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
        setInterval(() => {this.freezerUnit.evaluate(dT)}, dT)
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
        
        // history
        const sensorValue = this.temperatureSensor.sensorValue
        sensorValue.historizing = true
        functionalUnit.addressSpace.installHistoricalDataNode(sensorValue)
    }

    private async open(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.doorStateMachine.setState(LADSCoverState.Opened)
        return {statusCode: StatusCodes.Good }
    }

    private async close(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.doorStateMachine.setState(LADSCoverState.Closed)
        return {statusCode: StatusCodes.Good }
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
        const gAmbient = doorIsOpen?gDoorOpen:gDoorClosed 
        const qCompressor = this.compressorRunning?-1000:0 // Watt
        const qAmbient = dtAmbient * gAmbient
        const t = tpv + (qCompressor + qAmbient) / heatCapacity * 0.001 * dT 
        this.temperatureSensor.sensorValue.setValueFromSource({dataType: DataType.Double, value: t})
        this.temperatureController.currentValue.setValueFromSource({dataType: DataType.Double, value: t})

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
    const server = new FreezerServerImpl(4842)
    await server.start()
}

main()
