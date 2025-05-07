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

import { ApplicationType, assert, coerceNodeId, DataType, OPCUAServer, UAObject } from "node-opcua"
import { join } from "path"
import { DIObjectIds, getChildObjects } from "@utils"
import { pHMeterDevice } from "./ph-meter-interfaces"
import { pHMeterDeviceImpl } from "./ph-meter-device"

//---------------------------------------------------------------
export const IncludeAFO = true

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
// create and start server including a list of viscometers
//---------------------------------------------------------------
export async function main() {
    const server = new pHMeterServerImpl(4841)
    const argv = process.argv.slice()
    const portIdx = argv.indexOf('-p');
    const port = portIdx !== -1 ? String(argv[portIdx + 1]) : '';
    await server.start(port)
}

main()


