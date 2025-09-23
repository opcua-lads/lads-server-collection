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
import fs from "fs"
import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSComponentOptions, defaultLocation, initComponent, LADSDeviceHelper, getDeviceSet } from "@utils"
import { BalanceDevice, BalanceFunctionalUnit, BalanceFunctionalUnitSet } from "./interfaces"
import { BalanceDeviceConfig, BalanceProtocols } from "./server"
import { IAddressSpace, INamespace } from "node-opcua"
import { SimulatedBalanceUnitImpl } from "./unit-simulator"
import { BalanceEvents, DeviceInfo } from "./balance"
import { BalanceUnitImpl } from "./unit"
import { SerialBalanceUnitImpl } from "./unit-serial"

//--------------------------------------------------------------- 
export function getBalanceNameSpace(addressSpace: IAddressSpace): INamespace {return addressSpace.getNamespace("http://aixengineers.de/Balance/") }

export class BalanceDeviceImpl {
    config: BalanceDeviceConfig
    device: BalanceDevice
    deviceHelper: LADSDeviceHelper

    constructor(addressSpace: IAddressSpace, config: BalanceDeviceConfig) {

        // create device object
        const nameSpace = getBalanceNameSpace(addressSpace)
        const deviceType = nameSpace.findObjectType("BalanceDeviceType")
        const device = deviceType.instantiate({
            componentOf: getDeviceSet(addressSpace),
            browseName: config.name,
        }) as BalanceDevice
        this.device = device

        // create unit implementation
        this.config = config
        const balanceUnitImpl = this.getBalanceUnitImpl(config)
        balanceUnitImpl.balance.on(BalanceEvents.DeviceInfo, this.setNameplate.bind(this))

        // attach device helper
        this.deviceHelper = new LADSDeviceHelper(device)

        // set AFO dictionary entries
        AFODictionary.addDefaultDeviceReferences(device) // crawl through the complete information model tree and add default references
        AFODictionary.addReferences(device, AFODictionaryIds.measurement_device, AFODictionaryIds.weighing_device)
    }

    
    getBalanceUnitImpl(config: BalanceDeviceConfig): BalanceUnitImpl {
        const functionalUnit = this.getFunctionalUnit()
        const functionalUnitSet = this.getFunctionalUnitSet()
        switch (config.protocol) {
            case BalanceProtocols.SBI:
            case BalanceProtocols.SICS:
                return new SerialBalanceUnitImpl(this, functionalUnitSet, config)
            default:
                return new SimulatedBalanceUnitImpl(this, functionalUnitSet)
        }
    }

    getFunctionalUnitSet(): BalanceFunctionalUnitSet { return this.device.getComponentByName("FunctionalUnitSet") as BalanceFunctionalUnitSet }

    getFunctionalUnit(): BalanceFunctionalUnit {
        if (true) {
            const fus = this.device.getComponentByName("FunctionalUnitSet") as BalanceFunctionalUnitSet
            return fus.getComponentByName("BalanceUnit") as BalanceFunctionalUnit
        } else {
            return this.device.functionalUnitSet.balanceUnit
        }
    }

    setNameplate(deviceInfo: DeviceInfo) {
        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: deviceInfo.manufacturer,
            model: deviceInfo.model,
            serialNumber: deviceInfo.serialNumber || "Unknown",
            softwareRevision: deviceInfo.firmware || "",
            deviceRevision: deviceInfo.hardware|| "",
            assetId: "0815-4711",
            componentName: "My Balance",
            location: defaultLocation,
        }
        initComponent(this.device, deviceOptions)
    }

}

