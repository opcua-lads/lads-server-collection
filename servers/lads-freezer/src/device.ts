// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { DeviceTypeImage, initComponent, LADSDeviceHelper, setStringValue } from "@utils"
import { FreezerDevice } from "./interfaces"
import { FreezerUnitImpl } from "./unit"
import { DefaultHierarchicalLocation, FreezerConfig } from "./server"
import { join } from "path"

export class FreezerDeviceImpl {
    device: FreezerDevice
    freezerUnit: FreezerUnitImpl

    constructor(device: FreezerDevice, config: FreezerConfig) {
        this.device = device
 
        // device type image - if any
        const imageFile = config.deviceTypeImage ?? "default.png"
        const imagesDir = join(__dirname, "resources", "images")
        DeviceTypeImage.create({parent: this.device, imagesDir, imageFiles: [imageFile] })
 
        // initialize nameplates
        initComponent(device, config)
 
         // LCC PoC integration
         setStringValue(this.device.componentName, this.device.getDisplayName())
         setStringValue(this.device.hierarchicalLocation, config.hierarchicalLocation ?? DefaultHierarchicalLocation)
 
        // install default device helper
        const deviceHelper = new LADSDeviceHelper(this.device, { initializationTime: 2000, shutdownTime: 2000, raiseEvents: false })

        // create unit
        this.freezerUnit = new FreezerUnitImpl(device.functionalUnitSet.freezerUnit)

    }
}

