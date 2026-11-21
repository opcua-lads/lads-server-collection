// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assert, coerceNodeId, nodesets, OPCUAServer, UAObject } from "node-opcua"
import { join, resolve } from "path"
import { readFileSync } from "fs"
import { createServer, DefaultLocation, DIObjectIds, getChildObjects, LADSComponentOptions } from "@utils"
import { FreezerDevice } from "./interfaces"
import { FreezerDeviceImpl } from "./device"

//---------------------------------------------------------------
export interface FreezerConfig extends LADSComponentOptions {
    deviceTypeImage?: string
    hierarchicalLocation?: string
    /** server settings: OPC UA port and the application name the server announces (mDNS), unique per freezer */
    port?: number
    serverName?: string
    /** display name of the freezer device (default "MyFreezer" from the nodeset); the gateway derives the MHS device id from
     *  it, so every freezer that runs beside another one needs its own, e.g. "My Liebherr Freezer" -> my-liebherr-freezer */
    deviceName?: string
    /** "Eppendorf" (default) or "Liebherr": the built-in freezer the file starts from; the file overrides any of its keys */
    preset?: string
    /** storage: compartments, samples per compartment and the pattern of the sample ids they are loaded with
     * (see formatSampleId: "47{compartment:2}{index:4}" -> 47010001 …) */
    compartments?: number
    samplesPerCompartment?: number
    sampleIdPattern?: string
}

export const IncludeAFO = true

const LiebherrFreezer: FreezerConfig = {
    manufacturer: "Liebherr",
    manufacturerUri: "liebherr.com",
    model: "SUFsg 3501 Mediline",
    serialNumber: "4711",
    softwareRevision: "1.0",
    deviceRevision: "1.0",
    assetId: "0815-4711",
    componentName: "My Liebherr Freezer",
    location: DefaultLocation,
    deviceTypeImage: "liebherr-sufsg.png",
}

const EppendorfFreezer: FreezerConfig = {
    manufacturer: "Eppendorf",
    manufacturerUri: "eppendorf.com",
    model: "F740hi",
    serialNumber: "4711",
    softwareRevision: "1.0",
    deviceRevision: "1.0",
    assetId: "0815-4711",
    componentName: "My Eppendorf Freezer",
    location: DefaultLocation,
    deviceTypeImage: "eppendorf-f740hi.png",
}

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------
class FreezerServerImpl {
    server: OPCUAServer
    devices: FreezerDeviceImpl[] = []

    constructor(port: number, applicationName = "LADS Freezer", serialNumber = "4711") {
        const manufacturerUri = "aixengineers.de"
        const uri = `${manufacturerUri}/LADS-Freezer-Server`

        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = nodesets.standard
        const nodeset_di = nodesets.di
        const nodeset_amb = nodesets.amb
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_freezer = join(nodeset_path, 'Freezer.xml')
        const nodeset_afo = join(nodeset_path, 'AFO_Dictionary.NodeSet2.xml')

        const nodeset_filenames = [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_freezer, ...(IncludeAFO ? [nodeset_afo] : [])]
        this.server = createServer({
            applicationName,
            applicationDirectory: __dirname,
            port: port,
            uri: uri,
            serialNumber: serialNumber,   // part of the applicationUri: unique per instance
            nodeset_filenames
        })
    }

    async start(config: FreezerConfig) {

        // get objects
        await this.server.initialize()
        const addressSpace = this.server.engine.addressSpace
        const nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        const nameSpaceVM = addressSpace.getNamespace("http://spectaris.de/Freezer/")
        assert(nameSpaceVM)
        const freezerDeviceType = nameSpaceVM.findObjectType("FreezerDeviceType")
        assert(freezerDeviceType)
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nameSpaceDI.index))
        assert(deviceSet)
        const devices = getChildObjects(deviceSet)
        devices.forEach(device => {
            if (device.typeDefinitionObj === freezerDeviceType) {
                const freezerDevice = device as FreezerDevice
                if (config.deviceName) freezerDevice.setDisplayName(config.deviceName)
                const deviceImpl = new FreezerDeviceImpl(freezerDevice, config)
                this.devices.push(deviceImpl)
            }
        })

        // finalize start
        await this.server.start()
        const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl;
        console.log(this.server.buildInfo.productName, "is ready on", endpoint);
        console.log("CTRL+C to stop");
    }
}

/**
 * The freezer to run: the built-in Eppendorf freezer (port 4842, samples 4701… – as before), or the file given with
 * --config <file> (relative to the working directory): a JSON object with any FreezerConfig keys, e.g.
 * { "preset": "Liebherr", "port": 4846, "serverName": "LADS Freezer Aachen", "serialNumber": "4712",
 *   "componentName": "My Liebherr Freezer", "sampleIdPattern": "48{compartment:2}{index:4}" }
 */
function loadConfig(): FreezerConfig {
    const at = process.argv.indexOf("--config")
    if (at < 0) return { port: 4842, ...EppendorfFreezer }
    const path = resolve(process.argv[at + 1] ?? "")
    let file: FreezerConfig
    try {
        file = JSON.parse(readFileSync(path, "utf-8"))
    } catch (err) {
        console.error(`Freezer configuration ${path} could not be read: ${err}`)
        process.exit(1)
    }
    const base = (file.preset ?? "").toLowerCase() === "liebherr" ? LiebherrFreezer : EppendorfFreezer
    console.log(`Freezer configuration: ${path}`)
    return { port: 4842, ...base, ...file }
}

export async function main() {
    const config = loadConfig()
    const server = new FreezerServerImpl(config.port ?? 4842, config.serverName ?? "LADS Freezer", config.serialNumber ?? "4711")
    await server.start(config)
}

main()
