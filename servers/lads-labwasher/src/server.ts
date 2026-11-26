// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS LabWasher test / simulation server (skeleton): Miele LabWasher PG 8583

Loads the LabWasher nodeset (nodesets/LabWasher.xml) with its dependencies, creates an instance of LabWasherDeviceType
below DeviceSet (the nodeset has types only) and initialises it (device.ts): device type images, DI + Machinery
nameplates, locations, device helper, locks, the simulated washing unit (unit.ts).

    npm run lads-labwasher [-- -p <port>]
*/

import { join } from "path"
import assert from "assert"
import { exit } from "process"
import { coerceNodeId, OPCUAServer, UAObject } from "node-opcua"
import { createServer, DIObjectIds } from "@utils"
import { LADSDevice } from "@interfaces"
import { LabWasherDeviceImpl } from "./device"

const NS_LABWASHER = "http://spectaris.de/LabWasher/"

class LabWasherServerImpl {
    server: OPCUAServer

    constructor(port: number) {
        const uri = "LADS-LabWasher-Server"
        console.log(`${uri} starting ..`)
        const nodeset_path = join(process.cwd(), "nodesets")
        const nodeset_filenames = [
            join(nodeset_path, "Opc.Ua.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.Di.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.Machinery.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.AMB.NodeSet2.xml"),
            join(nodeset_path, "Opc.Ua.LADS.NodeSet2.xml"),
            join(nodeset_path, "LabWasher.xml"),
        ]
        this.server = createServer({ applicationName: "LADS LabWasher", applicationDirectory: __dirname, port, uri, nodeset_filenames })
    }

    async start() {
        await this.server.initialize()
        const addressSpace = this.server.engine.addressSpace
        const nsDI = addressSpace.getNamespace("http://opcfoundation.org/UA/DI/")
        const nsLW = addressSpace.getNamespace(NS_LABWASHER)
        assert(nsLW, `${NS_LABWASHER} not loaded`)
        const deviceType = nsLW.findObjectType("LabWasherDeviceType")
        assert(deviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nsDI.index))
        assert(deviceSet)

        const device = deviceType.instantiate({ browseName: { name: "LabWasher", namespaceIndex: nsLW.index }, displayName: "Miele LabWasher PG 8583", componentOf: deviceSet })
        new LabWasherDeviceImpl(device as unknown as LADSDevice, { serialNumber: "000018404821", componentName: "RDG", operationalLocation: "Washing room, bench 2" })

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
    const port = portIdx !== -1 ? Number(argv[portIdx + 1]) : 4852
    await new LabWasherServerImpl(port).start()
}

main()
