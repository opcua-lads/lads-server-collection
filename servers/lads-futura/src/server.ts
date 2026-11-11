// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Futura Connect Xtra (Aber Instruments) - static model, one device instance
Copyright (C) 2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
Licensed under the GNU Affero General Public License v3 or later, see <http://www.gnu.org/licenses/>.
*/

import { assert, coerceNodeId, OPCUAServer, UAObject, UAVariable } from "node-opcua"
import { join } from "path"
import { createServer, DIObjectIds, DeviceTypeImage, initComponent, LADSDeviceHelper, LADSComponentOptions, installVariableHistory, DefaultLocation, DefaultHierarchicalLocation } from "@utils"
import { LADSDevice } from "@interfaces"
import { exit } from "process"
import { FuturaSimulator } from "./simulator"
import { installFuturaCommands } from "./commands"
import { FuturaHealth } from "./health"

const NS_FUTURA = "http://aberinstruments.com/FuturaConnect/"

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------
class FuturaServerImpl {
    server: OPCUAServer

    constructor(port: number) {
        const uri = "LADS-Futura-Connect-Server"
        console.log(`${uri} starting ..`)

        // nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_filenames = [
            join(nodeset_path, 'Opc.Ua.NodeSet2.xml'),
            join(nodeset_path, 'Opc.Ua.Di.NodeSet2.xml'),
            join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml'),
            join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml'),
            join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml'),
            join(nodeset_path, 'FuturaConnect.xml'),
        ]
        this.server = createServer({
            applicationName: "LADS Futura Connect Xtra",
            applicationDirectory: __dirname,
            port,
            uri,
            nodeset_filenames
        })
    }

    async start() {
        // wait until server initialized
        await this.server.initialize()

        // create exactly one device instance below DeviceSet
        const addressSpace = this.server.engine.addressSpace
        const nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        const nameSpaceFutura = addressSpace.getNamespace(NS_FUTURA)
        assert(nameSpaceFutura)
        const deviceType = nameSpaceFutura.findObjectType("FuturaConnectDeviceType")
        assert(deviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nameSpaceDI.index))
        assert(deviceSet)
        const device = deviceType.instantiate({
            browseName: { name: "FuturaConnectXtra", namespaceIndex: nameSpaceFutura.index },
            componentOf: deviceSet,
        })
        const ladsDevice = device as unknown as LADSDevice

        // device images (DeviceTypeImage folder)
        DeviceTypeImage.create({ parent: ladsDevice, imagesDir: join(__dirname, "resources", "images") })

        // nameplate incl. Location and HierarchicalLocation (site defaults from config/lads-site.json)
        const manufacturer = "Aber Instruments"
        const model = "FUTURA Connect Xtra"
        const serialNumber = "08154711"
        const deviceOptions: LADSComponentOptions = {
            manufacturer, model, serialNumber,
            manufacturerUri: "aberinstruments.com",
            productInstanceUri: `aberinstruments.com/${model}/${serialNumber}`,   // provided by the firmware in the real device
            softwareRevision: "1.0", hardwareRevision: "1.0", deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: "My FUTURA Connect Xtra",
            location: DefaultLocation,
            hierarchicalLocation: DefaultHierarchicalLocation,
        } as LADSComponentOptions
        initComponent(ladsDevice, deviceOptions)
        const components = device.getChildByName("Components") as UAObject
        const componentOptions: { [name: string]: LADSComponentOptions } = {
            Probe: { manufacturer, model: "FUTURA Probe", serialNumber: "P-0815" },
            Futura: { manufacturer, model: "FUTURA Electronics", serialNumber: "F-0815", softwareRevision: "1.0" },
            Spectra: { manufacturer, model: "SPECTRA Module", serialNumber: "S-0815", softwareRevision: "1.0" },
        }
        for (const [name, options] of Object.entries(componentOptions)) {
            const component = components?.getChildByName(name)
            if (component) initComponent(component as any, options)
        }

        // history for the main measurements
        const sensorValue = (unit: string, fn: string) => {
            const node = (device.getChildByName("FunctionalUnitSet") as UAObject)?.getChildByName(unit)?.getChildByName("FunctionSet")?.getChildByName(fn)?.getChildByName("SensorValue")
            return node as UAVariable | null
        }
        for (const fn of ["BioMassMeasurement", "Conductivity", "Capacitance"]) installVariableHistory(sensorValue("Futura", fn)!)
        installVariableHistory(sensorValue("Spectra", "DerivedBiomass")!)

        // device helper: Machines folder, event notifier tree, device state machine (Initialization -> Operating)
        new LADSDeviceHelper(ladsDevice, { initializationTime: 2000, shutdownTime: 2000, raiseEvents: false, adjustFunctionIsEnabled: false })

        // command behaviour of the TwoStateDiscreteControlFunctions and StartProgram of the FUTURA unit
        const commands = installFuturaCommands(ladsDevice)

        // time-lapse simulator (programmatically created Simulator object below the device)
        const dataIdx = process.argv.indexOf('--data')
        const simulator = new FuturaSimulator(addressSpace, device, dataIdx !== -1 ? process.argv[dataIdx + 1] : undefined)
        if (process.argv.includes('--autostart')) simulator.start()

        // StatusFlags -> alarms -> DeviceHealth (writable StatusFlags in the Simulator object)
        new FuturaHealth(addressSpace, device)

        // effects of the commands on the simulated device
        const effect = (name: string, fn: () => void) => { const c = commands.get(name); if (c) c.onExecute = fn }
        effect("ZeroNow", () => simulator.zeroNow())
        effect("ClearZero", () => simulator.clearZero())
        effect("IncrementAutoclaveCount", () => simulator.incrementAutoclaveCount())

        // finalize start
        try {
            await this.server.start()
            const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl
            console.log(this.server.buildInfo.productName, "is ready on", endpoint)
            console.log("CTRL+C to stop")
        }
        catch (err: unknown) {
            console.error("Unable to start server: ", (err as Error).message)
            exit()
        }
    }
}

//---------------------------------------------------------------
export async function main() {
    const argv = process.argv.slice()
    const portIdx = argv.indexOf('-p')
    const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : 4848
    await new FuturaServerImpl(port).start()
}

main()
