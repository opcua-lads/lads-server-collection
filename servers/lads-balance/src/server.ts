// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Balance
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

import { ApplicationType, OPCUAServer } from "node-opcua"
import { join } from "path"
import { BalanceDeviceImpl } from "./device"
import { readFile } from "fs/promises"

//---------------------------------------------------------------
// config
//---------------------------------------------------------------
export enum BalanceProtocols {
    Simulator = "Simulator",
    SICS = "SICS",
    SBI = "SBI"
}
export interface BalanceConfig {
    port?: number
    includeAfo?: boolean;
    devices: BalanceDeviceConfig[]
}

export interface BalanceDeviceConfig {
    serialPort: string
    baudRate?: number
    parity?: string
    dataBits?: 7 | 8,
    stopBits?: 1 | 1.5 | 2 
    protocol: string
    name: string
    enabled?: boolean
}

// Type guard
function isBalanceConfig(obj: any): obj is BalanceConfig {
    return (
        Array.isArray(obj.devices) &&
        obj.devices.every(isBalanceDeviceConfig)
    )
}

function isBalanceDeviceConfig(obj: any): obj is BalanceDeviceConfig {
    return (
        typeof obj.name === 'string' &&
        typeof obj.serialPort === 'string' &&
        typeof obj.protocol === 'string'
    )
}

const DefaultConfig: BalanceConfig = {
    port: 4844,
    includeAfo: true,
    devices: [
        { serialPort: "", protocol: BalanceProtocols.Simulator, name: "My Simulated Balance" },
        //{ serialPort: "/dev/cu.PL2303G-USBtoUART210", protocol: BalanceProtocols.SBI, name: "My Sartorius Balance" },
        { serialPort: "/dev/tty.usbmodem00294063041", protocol: BalanceProtocols.SBI, name: "My Sartorius Balance" },
    ]
}

async function loadConfig(): Promise<BalanceConfig> {
    // load config
    const path = join(__dirname, "config.json")
    try {
        const content = await readFile(path, 'utf-8')
        const parsed = JSON.parse(content)
        return isBalanceConfig(parsed) ? parsed as BalanceConfig : DefaultConfig
    } catch (err) {
        console.warn(`Failed to load configuration file: ${path}`)
        return DefaultConfig
    }
}

export let IncludeAFO = false

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------

export class BalanceServerImpl {
    server: OPCUAServer
    config: BalanceConfig

    constructor(config: BalanceConfig) {
        this.config = config
        const port = this.config.port ?? 4844
        const uri = "LADS-Balance-Server"
        console.log(`${uri} starting ${IncludeAFO ? "with AFO support (takes some time to load) .." : ".."}`);

        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')
        const nodeset_balance = join(nodeset_path, 'Balance.xml')

        try {
            // list of node-set files
            const node_set_filenames = IncludeAFO ? [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_afo, nodeset_balance,] : [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_balance,]

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
                    applicationName: "LADS Balance",
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

    async start() {
        // wait until server initialized
        await this.server.initialize()

        // build structure
        const addressSpace = this.server.engine.addressSpace
        this.config.devices.forEach(deviceConfig => { 
            const enabled = deviceConfig.enabled ?? true
            if (enabled) {
                const device = new BalanceDeviceImpl(addressSpace, deviceConfig) 
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
// create and start server including a list of balances
//---------------------------------------------------------------
export async function main() {
    const config = await loadConfig()
    const includeAfo = config.includeAfo ?? true
    IncludeAFO = includeAfo
    const server = new BalanceServerImpl(config)
    await server.start()
}

main()
