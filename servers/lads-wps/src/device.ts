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

//---------------------------------------------------------------
// device implementation
//---------------------------------------------------------------
import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSComponentOptions, defaultLocation, initComponent, LADSDeviceHelper, getDeviceSet } from "@utils"
import { WpsDevice, WpsFunctionalUnit, WpsFunctionalUnitSet } from "./interfaces"
import { ServerConfig as WpsConfig, WpsServerImpl } from "./server"
import { IAddressSpace, INamespace } from "node-opcua"
import { WpsUnitImpl } from "./unit"

//--------------------------------------------------------------- 
export function getWpsNameSpace(addressSpace: IAddressSpace): INamespace {return addressSpace.getNamespace("http://aixengineers.de/WaterPurificationSystem/") }

export class WpsDeviceImpl {
    parent: WpsServerImpl
    config: WpsConfig
    device: WpsDevice
    deviceHelper: LADSDeviceHelper

    constructor(server: WpsServerImpl, config: WpsConfig) {

        // create device object
        this.parent = server
        this.config = config
        const addressSpace = this.parent.server.engine.addressSpace
        const nameSpace = getWpsNameSpace(addressSpace)
        const deviceType = nameSpace.findObjectType("WPSDeviceType")
        const device = deviceType.instantiate({
            componentOf: getDeviceSet(addressSpace),
            browseName: config.name,
        }) as WpsDevice
        this.device = device
        this.setNameplate(config)

        // create unit implementation
        const unitImpl = new WpsUnitImpl(this)

        // attach device helper
        this.deviceHelper = new LADSDeviceHelper(device)

        // set AFO dictionary entries
        AFODictionary.addDefaultDeviceReferences(device) // crawl through the complete information model tree and add default references
        AFODictionary.addReferences(device, AFODictionaryIds.purification)
    }

    
    getFunctionalUnitSet(): WpsFunctionalUnitSet { return this.device.getComponentByName("FunctionalUnitSet") as WpsFunctionalUnitSet }

    getFunctionalUnit(): WpsFunctionalUnit {
        const fus = this.device.getComponentByName("FunctionalUnitSet") as WpsFunctionalUnitSet
        return fus.getComponentByName("WPSUnit") as WpsFunctionalUnit
    }

    setNameplate(config: WpsConfig) {
        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: "Sartorius",
            model: "arium pro",
            serialNumber: "4711",
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: config.name,
            location: defaultLocation,
        }
        initComponent(this.device, deviceOptions)
    }

}

