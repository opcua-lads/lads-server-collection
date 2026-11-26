// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Device initialisation of the simulated Miele LabWasher PG 8583 (skeleton):

  1. DeviceTypeImage: the image files of resources/images (png, jpg, bmp, gif) as image variables
  2. nameplate: initComponent writes the DI nameplate and copies it to the Machinery Identification (with Identification/Location)
  3. locations: Identification/Location (geographical, from config/lads-site.json), HierarchicalLocation (site) and
     OperationalLocation (place in the lab)
  4. LADSDeviceHelper: Machinery building blocks, event notifier tree, DeviceState / MachineryItemState / OperationMode, DeviceHealth
  5. locks: device lock + one lock per functional unit (DeviceLocks)
  6. functional unit: WasherUnitImpl (StartProgram, Stop, Abort, Clear, washing program simulation)
*/

import { join } from "path"
import { UAObject } from "node-opcua"
import { LADSDevice } from "@interfaces"
import { DefaultHierarchicalLocation, DefaultLocation, DeviceTypeImage, getLADSFunctionalUnits, initComponent, LADSDeviceHelper } from "@utils"
import { DeviceLocks } from "./locks"
import { WasherUnitImpl } from "./unit"

export interface LabWasherDeviceOptions {
    serialNumber: string
    componentName: string
    operationalLocation: string
}

export class LabWasherDeviceImpl {
    readonly locks: DeviceLocks
    readonly units: WasherUnitImpl[] = []

    constructor(readonly device: LADSDevice, options: LabWasherDeviceOptions) {
        const name = (device as unknown as UAObject).getDisplayName()
        console.log(`Initializing LabWasher device ${name} ..`)

        // 1. device type images
        DeviceTypeImage.create({ parent: device as any, imagesDir: join(__dirname, "resources", "images") })

        // 2. + 3. nameplate (type plate of the PG 8583) with the locations
        initComponent(device as any, {
            manufacturer: "Miele", model: "PG 8583", productCode: "09960610", serialNumber: options.serialNumber,
            softwareRevision: "35913", deviceRevision: "E", hardwareRevision: "E",
            deviceManual: "https://www.miele.de/",
            assetId: `Miele LabWasher PG 8583 ${options.serialNumber}`, componentName: options.componentName,
            location: DefaultLocation,
            hierarchicalLocation: DefaultHierarchicalLocation,
            operationalLocation: options.operationalLocation,
        } as any)

        // 4. device helper (IsEnabled of the functions is set by the unit)
        new LADSDeviceHelper(device, { initializationTime: 2000, shutdownTime: 2000, raiseEvents: true, adjustFunctionIsEnabled: false })

        // 5. locks
        this.locks = new DeviceLocks(device)

        // 6. functional unit(s)
        for (const unit of getLADSFunctionalUnits(device)) {
            if (!unit.functionalUnitState) continue
            this.units.push(new WasherUnitImpl(unit, this.locks.predicate(unit.browseName.name)))
        }
    }
}
