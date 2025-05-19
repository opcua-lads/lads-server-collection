// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS pH-Meter
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
import { LADSComponent } from "@interfaces"
import { LADSComponentOptions, getStringValue, defaultLocation, initComponent, LADSDeviceHelper } from "@utils"
import { pHMeterDevice, pHMeterFunctionalUnit, pHMeterFunctionalUnitSet } from "./ph-meter-interfaces"
import { pHMeterSevenEasyUnitImpl } from "./ph-meter-unit-seven-easy"
import { pHMeterSimulatorUnitImpl } from "./ph-meter-unit-simulator"

//---------------------------------------------------------------
export class pHMeterDeviceImpl {
    serialPort: string
    device: pHMeterDevice

    static isSerialPortAvailable(path: string): boolean {
        try {
            // Check if the path exists and is a character device
            const stats = fs.statSync(path);
            return stats.isCharacterDevice();
        } catch {
            return false;
        }
    }
    constructor(device: pHMeterDevice, serialPort: string) {
        this.device = device
        this.serialPort = serialPort

        const functionalUnit = this.getFunctionalUnit()
        const runAsSimulation = !pHMeterDeviceImpl.isSerialPortAvailable(serialPort)
        console.log(`Running ${runAsSimulation ? "as simulator" : "device at port " + serialPort}..`)
        const functionalUnitImpl = runAsSimulation ? new pHMeterSimulatorUnitImpl(this, functionalUnit) : new pHMeterSevenEasyUnitImpl(this, functionalUnit, serialPort)

        // initialize nameplates
        const deviceOptions: LADSComponentOptions = {
            manufacturer: getStringValue(device.manufacturer, "Mettler Toledo"),
            model: getStringValue(device.model, "Super pH-Meter"),
            serialNumber: getStringValue(device.serialNumber, "4711"),
            softwareRevision: "1.0",
            deviceRevision: "1.0",
            assetId: "0815-4711",
            componentName: "My pH-meter",
            location: defaultLocation,
        }
        initComponent(device, deviceOptions)
        const components = device.getComponentByName("Components")
        const sensor = components.getComponentByName("pHSensor") as LADSComponent
        const sensorOptions: LADSComponentOptions = {
            manufacturer: "Mettler Toledo",
            model: "DPAS 405",
            serialNumber: "0815",
        }
        initComponent(sensor, sensorOptions)

        // attach device helper
        const helper = new LADSDeviceHelper(device)

        // set AFO dictionary entries
        AFODictionary.addDefaultDeviceReferences(device) // crawl through the complete information model tree and add default references
        AFODictionary.addReferences(device, AFODictionaryIds.measurement_device, AFODictionaryIds.pH_measurement)
    }

    getFunctionalUnit(): pHMeterFunctionalUnit {
        if (true) {
            const fus = this.device.getComponentByName("FunctionalUnitSet") as pHMeterFunctionalUnitSet
            return fus.getComponentByName("pHMeterUnit") as pHMeterFunctionalUnit
        } else {
            return this.device.functionalUnitSet.pHMeterUnit
        }
    }

}

