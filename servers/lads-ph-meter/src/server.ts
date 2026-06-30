// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS pH-Meter
Copyright (C) 2025  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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

import { ApplicationType, assert, coerceNodeId, DataType, LocalizedText, OPCUAServer, RegisterServerMethod, UAObject, AddressSpace } from "node-opcua"
import { join } from "path"
import { DIObjectIds, getChildObjects } from "@utils"
import { pHMeterDevice } from "./ph-meter-interfaces"
import { pHMeterDeviceImpl } from "./ph-meter-device"

//---------------------------------------------------------------
export const IncludeAFO = true

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
// server implementation
//---------------------------------------------------------------
class pHMeterServerImpl {
    server: OPCUAServer

    constructor(port: number) {
        const uri = "urn:MOCK930001:NodeOPCUA-Server"
        console.log(`${uri} starting ${IncludeAFO ? "with AFO support (takes some time to load) .." : ".."}`);

        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_phmeter = join(nodeset_path, 'pHMeter.xml')

        try {
            // list of node-set files
            const node_set_filenames = IncludeAFO ? [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_afo, nodeset_phmeter,] : [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_phmeter,]

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
                    applicationUri: uri, // unique URI for GDS registration

                },
                // nodesets used by the server
                nodeset_filename: node_set_filenames,
                // Register with GDS for auto-discovery
                registerServerMethod: RegisterServerMethod.MDNS,
                // discoveryServerEndpointUrl: process.env.GDS_URL || "opc.tcp://localhost:4850",
                // Capabilities will be set dynamically after initialize()
            })

        }
        catch (err) {
            console.log(err)
        }
    }

    async start(serialPort: string) {
        // wait until server initialized
        await this.server.initialize()

        // Detect and set capabilities from loaded namespaces
        const addressSpace = this.server.engine.addressSpace
        const capabilities = detectCapabilitiesFromNamespaces(addressSpace)
        console.log(`Detected capabilities: ${capabilities.join(', ')}`)
        // Set capabilities before start() triggers GDS registration
        ;(this.server as any).capabilitiesForMDNS = capabilities

        // build structure
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
                const pHMeterDevice = device as unknown as pHMeterDevice
                const index = deviceImplementations.length
                pHMeterDevice.serialNumber.setValueFromSource({ dataType: DataType.String, value: (4711 + index).toString() })
                deviceImplementations.push(new pHMeterDeviceImpl(pHMeterDevice, serialPort))
            }
        })

        // finalize start
        await this.server.start()
        const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl;
        console.log(this.server.buildInfo.productName, "is ready on", endpoint);

        // Validate GDS registration - detect applicationUri mismatch
        const configuredUri = this.server.serverInfo.applicationUri;
        const expectedUri = this.server.buildInfo.productUri;
        if (configuredUri !== expectedUri) {
            console.error(`\n⚠️  GDS REGISTRATION WARNING!`);
            console.error(`   Expected applicationUri: "${expectedUri}"`);
            console.error(`   Actual applicationUri:   "${configuredUri}"`);
            console.error(`   Another server may be using the same name.`);
            console.error(`   Fix: Ensure applicationUri is unique in serverInfo.\n`);
        }

        console.log("CTRL+C to stop");

        // TEST: Toggle FU DisplayName every 30s to trigger SemanticChangeEvent
        if (deviceImplementations.length > 0) {
            const firstDevice = deviceImplementations[0]
            const fu = firstDevice.getFunctionalUnit()
            const serverObject = addressSpace.rootFolder.objects.server
            const semanticChangeEventType = addressSpace.findEventType("SemanticChangeEventType")
            let toggle = false

            const raiseSemanticChange = (node: UAObject, message: string) => {
                if (semanticChangeEventType) {
                    serverObject.raiseEvent(semanticChangeEventType, {
                        message: { dataType: DataType.String, value: message },
                        sourceName: { dataType: DataType.String, value: node.nodeId.toString() },
                        severity: { dataType: DataType.UInt16, value: 0 },
                    })
                    console.log(`[TEST] SemanticChangeEvent raised for ${node.nodeId.toString()}`)
                }
            }

            // Toggle FU DisplayName every 30s
            setInterval(() => {
                toggle = !toggle
                const newName = toggle ? "pHMeterUnit (renamed)" : "pHMeterUnit"
                fu.setDisplayName(new LocalizedText({ text: newName }))
                console.log(`[TEST] FU DisplayName changed to "${newName}"`)
                raiseSemanticChange(fu as unknown as UAObject, `DisplayName changed to ${newName}`)
            }, 30000)

            // Rotate a Function DisplayName every 10s: Sensor Fake → Sensor Fake 2 → Sensor Fake 3 → ...
            const functionSet = fu.functionSet
            const pHSensorFunction = functionSet.getComponentByName("pHSensor") as UAObject
            if (pHSensorFunction) {
                let counter = 1
                setInterval(() => {
                    counter++
                    const fakeName = `Sensor Fake ${counter}`
                    pHSensorFunction.setDisplayName(new LocalizedText({ text: fakeName }))
                    console.log(`[TEST] Function DisplayName changed to "${fakeName}"`)
                    raiseSemanticChange(pHSensorFunction, `DisplayName changed to ${fakeName}`)
                }, 10000)
            }
        }
    }
}

//---------------------------------------------------------------
// create and start server including a list of viscometers
//---------------------------------------------------------------
export async function main() {
    const serverImpl = new pHMeterServerImpl(parseInt(process.env.PORT || "4843"))
    const argv = process.argv.slice()
    const portIdx = argv.indexOf('-p');
    const port = portIdx !== -1 ? String(argv[portIdx + 1]) : '';
    await serverImpl.start(port)

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
