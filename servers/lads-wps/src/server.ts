// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Water Purification System
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

import { nodesets, OPCUAServer } from "node-opcua"
import { join } from "path"
import { WpsDeviceImpl } from "./device"
import { readFile } from "fs/promises"
import { createServer } from "@utils"
import { Duration, LockImpl } from "@utils"
import { exit } from "process"

//---------------------------------------------------------------
// config
//---------------------------------------------------------------
export interface ServerConfig {
    port?: number
    includeAfo?: boolean;
    devices: DeviceConfig[]
}

export interface DeviceConfig {
    enabled: boolean
    name: string
    manufacturer: string
    model: string
    serialNumber: string
    hasUF?: boolean
    hasUV?: boolean
    hasTOC?: boolean
}

const DefaultConfig: ServerConfig = {
    port: 4845,
    includeAfo: true,
    devices: [
        {
            enabled: true,
            name: "My High-End Water Purification System",
            manufacturer: "sartorius",
            model: "arium pro VF",
            serialNumber: "4711",
            hasTOC: true,
            hasUF: true,
            hasUV: true
        },
        {
            enabled: true,
            name: "My Water Purification System",
            manufacturer: "sartorius",
            model: "arium pro DI",
            serialNumber: "4712",
        },
    ]
}

function isValid(config: ServerConfig): boolean { return false }

async function loadConfig(): Promise<ServerConfig> {
    // load config
    const path = join(__dirname, "config.json")
    try {
        const content = await readFile(path, 'utf-8')
        const parsed = JSON.parse(content)
        return isValid(parsed) ? parsed as ServerConfig : DefaultConfig
    } catch (err) {
        console.warn(`Failed to load configuration file: ${path}`)
        return DefaultConfig
    }
}

export let IncludeAFO = false

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------

export class WpsServerImpl {
    server: OPCUAServer
    config: ServerConfig

    constructor(config: ServerConfig) {
        this.config = config
        const port = this.config.port ?? 4845
        const uri = "LADS-WPS-Server"
        console.log(`${uri} starting ${IncludeAFO ? "with AFO support (takes some time to load) .." : ".."}`);

        // utilize node-opua nodeset files for built in version compatibility
        const nodeset_standard = nodesets.standard
        const nodeset_di = nodesets.di
        const nodeset_amb = nodesets.amb
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_lads_cd = join(nodeset_path, 'LADS-CD.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_wps = join(nodeset_path, 'WaterPurificationSystem.xml')

        // list of node-set files
        const nodeset_filenames = IncludeAFO ? [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_lads_cd, nodeset_afo, nodeset_wps,] : [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_lads_cd, nodeset_wps,]
        this.server = createServer({
            applicationName: "LADS Water Purification System",
            applicationDirectory: __dirname,
            port,
            uri,
            nodeset_filenames
        })
    }

    async start() {
        // wait until server initialized
        await this.server.initialize()

        // intall alarm & conditions
        const addressSpace = this.server.engine.addressSpace
        addressSpace.installAlarmsAndConditionsService()

        // initialize locking services
        LockImpl.initialize(addressSpace, 10 * Duration.Minute)

        this.config.devices.forEach(deviceConfig => {
            if (deviceConfig.enabled) {
                const device = new WpsDeviceImpl(this, deviceConfig)
            }
        })

        // finalize start
        try {
            await this.server.start()
            const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl;
            console.log(this.server.buildInfo.productName, "is ready on", endpoint);
            console.log("CTRL+C to stop")
        }
        catch (err) {
            console.error("Unable to start server: ", (err as Error).message)
            exit()
        }
    }
}

//---------------------------------------------------------------
// create and start server including a list of balances
//---------------------------------------------------------------
export async function main() {
    const config = await loadConfig()
    const includeAfo = config.includeAfo ?? true
    IncludeAFO = includeAfo
    const server = new WpsServerImpl(config)
    await server.start()
}

main()
