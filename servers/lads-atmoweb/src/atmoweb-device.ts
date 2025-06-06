// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS AtmoWEB gateway
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

import { LADSDevice } from "@interfaces";
import { AtmoWebDeviceConfig, AtmoWebServerImpl } from "./server";
import { AtmoWebUnitImpl } from "./atmoweb-unit";
import { AtmoWebClient } from "./atmoweb-client";
import { defaultLocation, getStringValue, initComponent, LADSComponentOptions, LADSDeviceHelper } from "@utils";
import { AFODictionary, AFODictionaryIds } from "@afo";

//---------------------------------------------------------------
// device implementation
//---------------------------------------------------------------
export class AtmoWebDeviceImpl {
    device: LADSDevice
    unitImpl: AtmoWebUnitImpl
    client: AtmoWebClient
    constructor(server: AtmoWebServerImpl, config: AtmoWebDeviceConfig) {

        // create device object
        const deviceSet = server.deviceSet
        const deviceType = server.nameSpaceApp.findObjectType("AtmoWebDeviceType")
        this.device = deviceType.instantiate({
            componentOf: deviceSet,
            browseName: config.name,
        }) as LADSDevice

        // create client
        this.client = new AtmoWebClient({ baseURL: config.baseUrl })

        // create unit implementation
        this.unitImpl = new AtmoWebUnitImpl(server, this, config)

        // build event notifier tree
        this.unitImpl.on("initialized", (data: any) => {
            // initialize nameplate
            const device = this.device
            const deviceOptions: LADSComponentOptions = {
                manufacturer: getStringValue(device.manufacturer, "Memmert GmbH"),
                model: data["DevType"],
                serialNumber: data["SN"],
                softwareRevision: data["SWRev"],
                deviceRevision: "1.0",
                assetId: "0815-4711",
                componentName: `My Memmert ${data["DevType"]} incubator`,
                location: defaultLocation,
            }
            initComponent(device, deviceOptions)
            // finalize
            const deviceHelper = new LADSDeviceHelper(this.device, { initializationTime: 2000, shutdownTime: 2000, raiseEvents: false })
            AFODictionary.addDefaultDeviceReferences(this.device)
            AFODictionary.addReferences(this.device, AFODictionaryIds.temperature_controlled_chamber)
        })
    }
}
