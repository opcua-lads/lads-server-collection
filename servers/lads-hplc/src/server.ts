// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS HPLC test / simulation server (skeleton)

Loads the HPLC nodeset (nodesets/HPLC.xml) with its dependencies, uses the device instance of the nodeset
(DeviceSet/AgilentCompactLC) or creates one of HPLCDeviceType, and initialises it (device.ts): device type images,
DI + Machinery nameplates, locations, device helper, locks, simulated functional units.

    npm run lads-hplc [-- -p <port>] [-- --new]      --new: a new instance of HPLCDeviceType instead of the nodeset's instance
*/

import { join } from "path"
import assert from "assert"
import { exit } from "process"
import { coerceNodeId, OPCUAServer, UAObject } from "node-opcua"
import { createServer, DIObjectIds } from "@utils"
import { LADSDevice } from "@interfaces"
import { HPLCDeviceImpl } from "./device"

const NS_HPLC = "http://spectaris.de/HPLC/"

class HPLCServerImpl {
    server: OPCUAServer

    constructor(port: number) {
        const uri = "LADS-HPLC-Server"
        console.log(`${uri} starting ..`)
        const nodeset_path = join(process.cwd(), "nodesets")
        const nodeset_filenames = [
            join(nodeset_path, "Opc.Ua.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.Di.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.Machinery.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.AMB.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.LADS.NodeSet2.xml"),
            join(nodeset_path, "HPLC.xml"),
        ]
        this.server = createServer({ applicationName: "LADS HPLC", applicationDirectory: __dirname, port, uri, nodeset_filenames })
    }

    async start(newInstance: boolean) {
        await this.server.initialize()
        const addressSpace = this.server.engine.addressSpace
        const nsDI = addressSpace.getNamespace("http://opcfoundation.org/UA/DI/")
        const nsHPLC = addressSpace.getNamespace(NS_HPLC)
        assert(nsHPLC, `${NS_HPLC} not loaded`)
        const deviceType = nsHPLC.findObjectType("HPLCDeviceType")
        assert(deviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nsDI.index))
        assert(deviceSet)

        // the instance of the nodeset, or a new one
        let device = newInstance ? null : deviceSet.getComponents().find(c => (c as UAObject).typeDefinitionObj === deviceType) as UAObject | undefined
        if (!device) {
            device = deviceType.instantiate({ browseName: { name: "HPLC", namespaceIndex: nsHPLC.index }, componentOf: deviceSet })
        }
        new HPLCDeviceImpl(device as unknown as LADSDevice, { serialNumber: "DEAAX01234", componentName: "My HPLC", operationalLocation: "HPLC bench 1" })

        try {
            await this.server.start()
            const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl
            console.log(this.server.buildInfo.productName, "is ready on", endpoint)
            console.log("CTRL+C to stop")
        } catch (err: unknown) {
            console.error("Unable to start server: ", (err as Error).message)
            exit(1)
        }
    }
}

export async function main() {
    const argv = process.argv
    const portIdx = argv.indexOf("-p")
    const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : 4851
    await new HPLCServerImpl(port).start(argv.includes("--new"))
}

main()
