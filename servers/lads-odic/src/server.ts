// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Minimal ODIC server: loads the ODIC nodeset (nodesets/ODIC.xml) with its dependencies and creates an instance of
ExperimentalFacilityDeviceType below DeviceSet, so that the model can be browsed with an OPC UA client.
No behaviour (no state machine logic), no device type images, no locks.

    npm run lads-odic [-- -p <port>]
*/

import { join } from "path"
import assert from "assert"
import { exit } from "process"
import { coerceNodeId, OPCUAServer, UAObject } from "node-opcua"
import { createServer, DIObjectIds } from "@utils"

const NS_ODIC = "http://spectaris.de/ODIC/"

async function main() {
    const portIdx = process.argv.indexOf("-p")
    const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 4853
    const uri = "LADS-ODIC-Server"
    const nodeset_path = join(process.cwd(), "nodesets")
    const nodeset_filenames = [
        "Opc.Ua.NodeSet2.xml", "Opc.Ua.Di.NodeSet2.xml", "Opc.Ua.Machinery.NodeSet2.xml", "Opc.Ua.AMB.NodeSet2.xml", "Opc.Ua.LADS.NodeSet2.xml", "ODIC.xml",
    ].map((file) => join(nodeset_path, file))

    console.log(`${uri} starting ..`)
    const server: OPCUAServer = createServer({ applicationName: "LADS ODIC", applicationDirectory: __dirname, port, uri, nodeset_filenames, ldsSupport: false })
    await server.initialize()

    const addressSpace = server.engine.addressSpace
    const nsDI = addressSpace.getNamespace("http://opcfoundation.org/UA/DI/")
    const nsODIC = addressSpace.getNamespace(NS_ODIC)
    assert(nsODIC, `${NS_ODIC} not loaded`)
    const deviceType = nsODIC.findObjectType("ExperimentalFacilityDeviceType")
    assert(deviceType)
    const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nsDI.index))
    assert(deviceSet)
    deviceType.instantiate({ browseName: { name: "ExperimentalFacility", namespaceIndex: nsODIC.index }, displayName: "Experimental Facility", componentOf: deviceSet })

    try {
        await server.start()
        console.log(server.buildInfo.productName, "is ready on", server.endpoints[0].endpointDescriptions()[0].endpointUrl)
        console.log("CTRL+C to stop")
    } catch (err: unknown) {
        console.error("Unable to start server: ", (err as Error).message)
        exit(1)
    }
}

main()
