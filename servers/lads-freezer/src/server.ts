// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assert, coerceNodeId, OPCUAServer, UAObject } from "node-opcua"
import { join } from "path"
import { createServer, defaultLocation, DIObjectIds, getChildObjects, LADSComponentOptions } from "@utils"
import { FreezerDevice } from "./interfaces"
import { FreezerDeviceImpl } from "./device"

//---------------------------------------------------------------
export interface FreezerConfig extends LADSComponentOptions {
    deviceTypeImage?: string
    hierarchicalLocation?: string
}

export const DefaultHierarchicalLocation = "DE/Munich/Schragenhofstr_35/A/Office"

const LiebherrFreezer: FreezerConfig = {
    manufacturer: "Liebherr",
    manufacturerUri: "liebherr.com",
    model: "SUFsg 3501 Mediline",
    serialNumber: "4711",
    softwareRevision: "1.0",
    deviceRevision: "1.0",
    assetId: "0815-4711",
    componentName: "My Liebherr Freezer",
    location: defaultLocation,
    deviceTypeImage: "liebherr-susfg.png",
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
    location: defaultLocation,
    deviceTypeImage: "eppendorf-f740hi.png",
}

//---------------------------------------------------------------
// server implementation
//---------------------------------------------------------------
class FreezerServerImpl {
    server: OPCUAServer
    devices: FreezerDeviceImpl[] = []

    constructor(port: number) {
        const manufacturerUri = "aixengineers.de"
        const uri = `${manufacturerUri}/LADS-Freezer-Server`
        const applicationUri = `${uri}/4711`

        // provide paths for the nodeset files
        const nodeset_path = join(process.cwd(), 'nodesets')
        const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
        const nodeset_di = join(nodeset_path, 'Opc.Ua.Di.NodeSet2.xml')
        const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
        const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
        const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
        const nodeset_freezer = join(nodeset_path, 'Freezer.xml')

        const nodeset_filenames = [nodeset_standard, nodeset_di, nodeset_machinery, nodeset_amb, nodeset_lads, nodeset_freezer,]
        this.server = createServer({
            applicationName: "LADS Freezer",
            applicationDirectory: __dirname,
            port: port,
            uri: uri,
            applicationUri: applicationUri,
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

export async function main() {
    const server = new FreezerServerImpl(4842)
    await server.start(EppendorfFreezer)
}

main()
