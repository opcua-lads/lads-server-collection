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

import { ApplicationType, assert, coerceNodeId, DataType, OPCUAServer, RegisterServerMethod, UAObject, MessageSecurityMode, SecurityPolicy, OPCUACertificateManager } from "node-opcua"
import { join, resolve } from "path"
import { existsSync } from "fs"
import { DIObjectIds, getChildObjects } from "@utils"
import { pHMeterDevice } from "./ph-meter-interfaces"
import { pHMeterDeviceImpl } from "./ph-meter-device"

// PKI folder for certificates (node-opcua standard structure)
const PKI_DIR = process.env.OPCUA_PKI_DIR || resolve(__dirname, "../../../../lcc-backend/test/integration/certs/server-pki")

//---------------------------------------------------------------
export const IncludeAFO = false  // Disabled for faster test startup

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------
class pHMeterServerImpl {
    server: OPCUAServer
    private serverCertificateManager: OPCUACertificateManager

    constructor(port: number) {
        const uri = `urn:${require("os").hostname()}:LADS-Test-Server`
        console.log(`LADS-pH-Meter-Secure starting with OPCUACertificateManager...`);
        console.log(`  PKI folder: ${PKI_DIR}`);
        console.log(`  Application URI: ${uri}`);

        // Verify PKI folder exists
        if (!existsSync(PKI_DIR)) {
            console.error(`ERROR: PKI folder not found at ${PKI_DIR}`);
            console.error(`Run: cd lcc-backend/test/integration/certs && bash generate-certs.sh`);
            process.exit(1);
        }

        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_phmeter = join(nodeset_path, 'pHMeter.xml')

        // Create certificate manager with PKI folder structure
        this.serverCertificateManager = new OPCUACertificateManager({
            automaticallyAcceptUnknownCertificate: true, // For testing - accept client certs
            rootFolder: PKI_DIR,
            name: "ServerPKI",
        });

        try {
            // list of node-set files
            const node_set_filenames = IncludeAFO ? [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_afo, nodeset_phmeter,] : [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_phmeter,]

            // build the server object
            this.server = new OPCUAServer({
                port: port,
                // basic information about the server
                buildInfo: {
                    manufacturerName: "AixEngineers",
                    productName: "LADS-pH-Meter-Secure",
                    productUri: uri,
                    softwareVersion: "1.0.0",
                },
                serverInfo: {
                    applicationName: { text: "LADS pH-Meter Secure" },
                    applicationType: ApplicationType.Server,
                    productUri: uri,
                    applicationUri: uri, // Must match certificate subjectAltName URI

                },
                // nodesets used by the server
                nodeset_filename: node_set_filenames,

                // Use OPCUACertificateManager for security
                serverCertificateManager: this.serverCertificateManager,
                securityPolicies: [
                    SecurityPolicy.None,
                    SecurityPolicy.Basic256Sha256,
                ],
                securityModes: [
                    MessageSecurityMode.None,
                    MessageSecurityMode.SignAndEncrypt,
                ],

                // User authentication
                allowAnonymous: true,
                userManager: {
                    isValidUserAsync: async (userName: string | null, password: string | null): Promise<boolean> => {
                        // Allow anonymous
                        if (!userName && !password) return true;
                        // Test credentials
                        if (userName === "testuser" && password === "testpass") return true;
                        return false;
                    },
                },

                // Register with GDS for auto-discovery
                registerServerMethod: RegisterServerMethod.LDS,
                discoveryServerEndpointUrl: process.env.GDS_URL || "opc.tcp://localhost:4850",
            })

        }
        catch (err) {
            console.log(err)
        }
    }

    async start(serialPort: string) {
        // Initialize certificate manager first
        await this.serverCertificateManager.initialize();
        console.log(`  PKI initialized`);

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
    }
}

//---------------------------------------------------------------
// create and start server including a list of viscometers
//---------------------------------------------------------------
export async function main() {
    const serverImpl = new pHMeterServerImpl(4843)
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
