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
import { IAddressSpace } from "node-opcua"
import { SimulatedBalanceUnitImpl } from "./unit-simulator"
import { BalanceEvents, DeviceInfo } from "./balance"
import { BalanceUnitImpl } from "./unit"
import { SerialBalanceUnitImpl } from "./unit-serial"

//--------------------------------------------------------------- 

export class BalanceDeviceImpl {
    config: BalanceDeviceConfig
    device: BalanceDevice

    static isSerialPortAvailable(path: string): boolean {
        try {
            // Check if the path exists and is a character device
            const stats = fs.statSync(path);
            return stats.isCharacterDevice();
        } catch {
            return false;
        }
    }

    constructor(addressSpace: IAddressSpace, config: BalanceDeviceConfig) {

        // create device object
        const nameSpace = addressSpace.getNamespace("http://aixengineers.de/Balance/")
        const deviceType = nameSpace.findObjectType("BalanceDeviceType")
        const device = deviceType.instantiate({
            componentOf: getDeviceSet(addressSpace),
            browseName: config.name,
        }) as BalanceDevice
        this.device = device

        const balanceUnitImpl = this.getBalanceUnitImpl(config)
        balanceUnitImpl.balance.on(BalanceEvents.DeviceInfo, this.setNameplate.bind(this))

        // attach device helper
        const helper = new LADSDeviceHelper(device)

        // set AFO dictionary entries
        AFODictionary.addDefaultDeviceReferences(device) // crawl through the complete information model tree and add default references
        AFODictionary.addReferences(device, AFODictionaryIds.measurement_device, AFODictionaryIds.weighing_device)
    }

    getBalanceUnitImpl(config: BalanceDeviceConfig): BalanceUnitImpl {
        const functionalUnit = this.getFunctionalUnit()
        switch (config.protocol) {
            case BalanceProtocols.SBI:
            case BalanceProtocols.SICS:
                return new SerialBalanceUnitImpl(this, functionalUnit, config)
            default:
                return new SimulatedBalanceUnitImpl(this, functionalUnit)
        }
    }

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

