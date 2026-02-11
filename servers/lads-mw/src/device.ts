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
import { LADSComponentOptions, defaultLocation, initComponent, LADSDeviceHelper, getDeviceSet, setNumericValue, raiseEvent } from "@utils"
import { MWDevice, MWFunctionalUnit, MWFunctionalUnitSet } from "./interfaces"
import { DeviceConfig, MWServerImpl,  } from "./server"
import { IAddressSpace, INamespace, LocalizedText, UAObject } from "node-opcua"
import { EnumDeviceHealth } from "node-opcua-nodeset-di"
import { LockImpl } from "utils/src/lads-lock"
import { MWUnitImpl } from "./unit"


//--------------------------------------------------------------- 
export function getMWNameSpace(addressSpace: IAddressSpace): INamespace { return addressSpace.getNamespace("http://tewsworks.com/MW5X/") }

export enum LifetimeStatus {Good, Warning, Exceeded}

export const Manufacturer = "TEWS Elektronik GmbH & Co. KG"

export class MWDeviceImpl {
    parent: MWServerImpl
    config: DeviceConfig
    device: MWDevice
    deviceHelper: LADSDeviceHelper
    lock: LockImpl = undefined

    constructor(server: MWServerImpl, config: DeviceConfig) {
        // create device object
        this.parent = server
        this.config = config
        const addressSpace = this.parent.server.engine.addressSpace
        const nameSpace = getMWNameSpace(addressSpace)
        const deviceType = nameSpace.findObjectType("MWDeviceType")
        const device = deviceType.instantiate({
            componentOf: getDeviceSet(addressSpace),
            browseName: config.name,
            optionals: []
        }) as MWDevice
        this.device = device
        this.initComponents(config)

        // eventually initialize lock
        if (this.device.lock) {
            this.lock = new LockImpl(this.device.lock)
        }
        
        const optionals = config.hasLB ? ["FunctionSet.LightBarrier1", "FunctionSet.LightBarrier2", "FunctionSet.LightBarrier3"] : []
        const unitImpl = new MWUnitImpl(this, optionals)

        // attach device helper
        this.deviceHelper = new LADSDeviceHelper(device, {raiseEvents: false})

        // set AFO dictionary entries
        AFODictionary.addDefaultDeviceReferences(device) // crawl through the complete information model tree and add default references
        AFODictionary.addReferences(device, AFODictionaryIds.densitometry, AFODictionaryIds.humidity)


        // register events
        this.device.deviceHealth?.on("value_changed", (dataValue) => raiseEvent(this.device, `Device health changed to ${EnumDeviceHealth[dataValue.value.value]}`))
        this.device.machineryOperationMode?.currentState?.on("value_changed", (dataValue) => raiseEvent(this.device, `Device operation mode changed to ${(dataValue.value.value as LocalizedText).text}`))
        
        // ready
        console.log(`Added device "${config.name}" (${config.manufacturer ?? Manufacturer} ${config.model} SN${config.serialNumber})`)
    }


    getFunctionalUnitSet(): MWFunctionalUnitSet { return this.device.getComponentByName("FunctionalUnitSet") as MWFunctionalUnitSet }

    getFunctionalUnit(): MWFunctionalUnit {
        const fus = this.device.getComponentByName("FunctionalUnitSet") as MWFunctionalUnitSet
        return fus.getComponentByName("WPSUnit") as MWFunctionalUnit
    }

    initComponents(config: DeviceConfig) {
        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: config.manufacturer ?? Manufacturer,
            model: config.model,
            serialNumber: config.serialNumber,
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: config.name,
            location: defaultLocation,
        }
        initComponent(this.device, deviceOptions)

        // subscribe to device health changes
        setNumericValue(this.device.deviceHealth, EnumDeviceHealth.NORMAL)
    }


}

