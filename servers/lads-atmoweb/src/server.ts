// SPDX-FileCopyrightText: 2025-2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS AtmoWEB gateway
Copyright (C) 2025-2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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

import { ApplicationType, coerceNodeId, INamespace, OPCUAServer, UAObject } from "node-opcua"
import { join } from "path"
import { createServer, DIObjectIds } from "@utils"
import { AtmoWebDeviceImpl } from "./device"
import { readFile } from "fs/promises"

//---------------------------------------------------------------
export const IncludeAFO = false

//---------------------------------------------------------------
// config
//---------------------------------------------------------------
export interface AtmoWebConfig {
    devices: AtmoWebDeviceConfig[]
}

export interface AtmoWebDeviceConfig {
    baseUrl: string
    name: string
    recorderInterval?: number
    hierachicalLocation?: string
}

// Type guard
function isAtmoWebConfig(obj: any): obj is AtmoWebConfig {
    return (
        Array.isArray(obj.devices) &&
        obj.steps.every(isAtmoWebDeviceConfig)
    )
}

function isAtmoWebDeviceConfig(obj: any): obj is AtmoWebDeviceConfig {
    return (
        typeof obj.name === 'string' &&
        typeof obj.address === 'string'
    )
}

const DefaultConfig: AtmoWebConfig = {
    devices: [
        { baseUrl: "http://localhost:8081", name: "My Memmert UN plus", recorderInterval: 5, hierachicalLocation: "DE/Munich/Schragenhofstr_35/A/Office" },
        { baseUrl: "http://localhost:8082", name: "My Memmert ICO", recorderInterval: 5, hierachicalLocation: "DE/Munich/Schragenhofstr_35/A/Office" },
        { baseUrl: "http://localhost:8083", name: "My Memmert IN plus", recorderInterval: 5, hierachicalLocation: "DE/Munich/Schragenhofstr_35/A/Office" },
        { baseUrl: "http://localhost:8084", name: "My Memmert VO", recorderInterval: 5, hierachicalLocation: "DE/Munich/Schragenhofstr_35/A/Office" },
    ],
}

async function loadConfig(): Promise<AtmoWebConfig> {
    // load config
    const path = join(__dirname, "config.json")
    try {
        const content = await readFile(path, 'utf-8')
        const parsed = JSON.parse(content)
        return isAtmoWebConfig(parsed) ? parsed as AtmoWebConfig : DefaultConfig
    } catch (err) {
        console.warn(`Failed to load configuration file: ${path}`)
        console.log(`Running in simulation mode`)
        return DefaultConfig
    }
}

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------
export class AtmoWebServerImpl {
    server: OPCUAServer
    nameSpaceDI : INamespace
    nameSpaceApp: INamespace
    deviceSet: UAObject
    deviceImplementations: AtmoWebDeviceImpl[] = []

    constructor(port: number) {
        const uri = "LADS-AtmoWEB-Server"
        console.log(`${uri} starting ${IncludeAFO ? "with AFO support (takes some time to load) .." : ".."}`);

        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_atmo_web = join(nodeset_path, 'AtmoWeb.xml')

        // list of node-set files
        const nodeset_filenames = IncludeAFO ? [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_afo, nodeset_atmo_web] : [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_atmo_web]
        this.server = createServer({
            applicationName: "LADS AtmoWEB Gateway",
            applicationDirectory: __dirname,
            port,
            uri,
            nodeset_filenames
        })
          
    }

    async start() {
        // wait until server initialized
        await this.server.initialize()

        // build structure
        const addressSpace = this.server.engine.addressSpace
        this.nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        this.nameSpaceApp = addressSpace.getNamespace('http://aixengineers.de/AtmoWeb/')
        this.deviceSet = addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, this.nameSpaceDI.index)) as UAObject

        const config = await loadConfig()
        config.devices.forEach(deviceConfig => {
            const device = new AtmoWebDeviceImpl(this, deviceConfig)
            this.deviceImplementations.push(device)
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
    const server = new AtmoWebServerImpl(4843)
    await server.start()
}

main()
