// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Viscometer
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

import { setLogLevel, LogLevel } from "node-opcua-debug";
setLogLevel(LogLevel.Error)

import { join } from 'path'
import assert from "assert"
import { ApplicationType, OPCUAServer, UAObject, coerceNodeId, } from "node-opcua"
import { DIObjectIds, setStringValue, } from "@utils"
import { ViscometerDevice } from './interfaces'
import { ViscometerDeviceImpl } from './device'

//---------------------------------------------------------------
// server configuration
//---------------------------------------------------------------
export interface ControllerOptions {
    serialPort?: string
}

export interface DeviceOptions {
    name: string
    viscometerController?: ControllerOptions
    temperatureController?: ControllerOptions
}

interface ServerOptions {
    port?: number
    includeAFO?: boolean
    deviceOptions: DeviceOptions[]
}

const DefaultServerOptions: ServerOptions  = {
    deviceOptions: [{
        name: "My Viscometer",
        temperatureController: { serialPort: "/dev/tty.usbserial-2110"}
    }]
}

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------
class ViscometerServerImpl {
    options: ServerOptions
    server: OPCUAServer

    constructor(options: ServerOptions) {
        this.options = options
        const includeAFO = options.includeAFO ?? false
        const port = options.port ?? 4840

        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_viscometer = join(nodeset_path, 'Viscometer.xml')

        try {
            // list of node-set files
            const node_set_filenames = includeAFO ? [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_afo, nodeset_viscometer,] : [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_viscometer,]

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

    async start() {
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
        this.options.deviceOptions.forEach((deviceOptions, index) => {
            const name = deviceOptions.name
            const deviceObject = <ViscometerDevice>deviceType.instantiate({
                componentOf: deviceSet,
                browseName: name,
            })
            setStringValue(deviceObject.serialNumber, (4711 + index).toString())
            const deviceImpl = new ViscometerDeviceImpl(deviceObject, deviceOptions)
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
    const server = new ViscometerServerImpl(DefaultServerOptions)
    await server.start()
}

main()
