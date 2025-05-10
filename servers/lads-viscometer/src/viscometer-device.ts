// SPDX-FileCopyrightText: 2025 Dr.x Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Viscometer
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

import { AFODictionary, AFODictionaryIds } from "@afo"
import { LADSComponentOptions, getStringValue, defaultLocation, initComponent, LADSDeviceHelper } from "@utils"
import { assert, coerceNodeId, IAddressSpace, ObjectTypeIds, UAEventType } from "node-opcua"
import { ViscometerDevice } from "./viscometer-interfaces"
import { ViscometerUnitImpl } from "./viscometer-unit"
import { ViscometerUnitSimulatorImpl } from "./viscometer-unit-simulator"

//---------------------------------------------------------------
// device implementation
//---------------------------------------------------------------
export interface ViscometerSpindleParameters {
    name: string
    code: number
    smc: number
    src: number
}

export const ViscometerSpindles: ViscometerSpindleParameters[] = [
    {name: "RV1", code: 1, smc: 1, src: 0},
    {name: "RV2", code: 2, smc: 4, src: 0},
    {name: "RV3", code: 3, smc: 10, src: 0},
    {name: "RV4", code: 4, smc: 20, src: 0},
    {name: "RV5", code: 5, smc: 40, src: 0},
    {name: "RV6", code: 6, smc: 100, src: 0},
    {name: "RV7", code: 7, smc: 400, src: 0},
    {name: "HA1", code: 1, smc: 1, src: 0},
    {name: "HA2", code: 2, smc: 4, src: 0},
    {name: "HA3", code: 3, smc: 10, src: 0},
    {name: "HA4", code: 4, smc: 20, src: 0},
    {name: "HA5", code: 5, smc: 40, src: 0},
    {name: "HA6", code: 6, smc: 100, src: 0},
    {name: "HA7", code: 7, smc: 400, src: 0},
    {name: "HB1", code: 1, smc: 1, src: 0},
    {name: "HB2", code: 2, smc: 4, src: 0},
    {name: "HB3", code: 3, smc: 10, src: 0},
    {name: "HB4", code: 4, smc: 20, src: 0},
    {name: "HB5", code: 5, smc: 40, src: 0},
    {name: "HB6", code: 6, smc: 100, src: 0},
    {name: "HB7", code: 7, smc: 400, src: 0},
    {name: "DIN81", code: 81, smc: 3.7, src: 1.29},
    {name: "DIN82", code: 82, smc: 3.75, src: 1.29},
    {name: "DIN83", code: 83, smc: 12.09, src: 1.29},
    {name: "DIN85", code: 85, smc: 1.22, src: 1.29},
    {name: "DIN86", code: 86, smc: 3.65, src: 1.29},
    {name: "DIN87", code: 87, smc: 12.13, src: 1.29},
    {name: "SC4-14", code: 14, smc: 125, src: 0.4},
    {name: "SC4-15", code: 15, smc: 50, src: 0.48},
    {name: "SC4-16", code: 16, smc: 128, src: 0.29},
    {name: "SC4-18", code: 18, smc: 3.2, src: 1.32},
    {name: "SC4-21", code: 21, smc: 5, src: 0.93},
    {name: "SC4-25", code: 25, smc: 512, src: 0.22},
    {name: "SC4-27", code: 27, smc: 125, src: 0.4},
    {name: "SC4-28", code: 28, smc: 50, src: 0.28},
    {name: "SC4-29", code: 29, smc: 100, src: 0.25},
    {name: "SC4-31", code: 31, smc: 32, src: 0.34},
    {name: "SC4-34", code: 34, smc: 64, src: 0.28},
]

export interface ViscometerModelParameters { name: string, tk: number, code: string}

export const ViscometerModels: ViscometerModelParameters[] = [
    {name: "LVDV-II+", tk: 0.09373, code: "LV"},
    {name: "2.5LVDV-II+", tk: 0.2343, code: "2.5 LV"},
    {name: "5LVDV-II+", tk: 0.4686, code: "5 LV"},
    {name: "1/4 RVDV-II+", tk: 0.25, code: "0.25 RV"},
    {name: "1/2 RVDV-II+", tk: 0.5, code: "0.5 RV"},
    {name: "RVDV-II+", tk: 1.0, code: "RV"},
    {name: "HADV-II+", tk: 2.0, code: "HA"},
    {name: "2HADV-II+", tk: 4.0, code: "2 HA"},
    {name: "2.5HADV-II+", tk: 5.0, code: "2.5 HA"},
    {name: "HBDV-II+", tk: 8.0, code: "HB"},
    {name: "2HBDV-II+", tk: 16.0, code: "2 HB"},
    {name: "2.5HBDV-II+", tk: 20.0, code: "2.5 HB"},
]

export class ViscometerDeviceImpl {
    addressSpace: IAddressSpace
    baseEventType: UAEventType
    device: ViscometerDevice
    viscometerUnitImpl: ViscometerUnitImpl

    constructor(device: ViscometerDevice, serialPort: string) {
        this.device = device
        const name = this.device.getDisplayName()
        console.log(`Initializing viscometer device ${name}..`)

        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: getStringValue(device.manufacturer, "Brookfield Engineering"),
            model: getStringValue(device.model, "LVDV-II+"),
            serialNumber: getStringValue(device.serialNumber, "4711"),
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: `My ${name}`,
            location: defaultLocation,
        }
        initComponent(device, deviceOptions)
        
        // initialize device
        const deviceHelper = new LADSDeviceHelper(this.device, {initializationTime: 2000, shutdownTime: 2000, raiseEvents: true})
        this.addressSpace = this.device.addressSpace
        this.baseEventType = this.addressSpace.findEventType(coerceNodeId(ObjectTypeIds.BaseEventType))
        const viscometerUnit = this.device.functionalUnitSet.viscometerUnit
        assert(viscometerUnit)
        // create simulated or real world device
        this.viscometerUnitImpl = new ViscometerUnitSimulatorImpl(this, viscometerUnit)

        // Allotrope Foundation Ontologoes
        AFODictionary.addDefaultDeviceReferences(device)
        AFODictionary.addReferences(device, AFODictionaryIds.measurement_device, AFODictionaryIds.rheometry, AFODictionaryIds.viscometry)
    }
}


