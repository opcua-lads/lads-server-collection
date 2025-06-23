// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
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

import { LADSComponentOptions } from "@utils"
import { ControllerOptions } from "./server"
import { ViscometerUnitImpl } from "./unit"

//---------------------------------------------------------------
// abstract controller-device implementation
//---------------------------------------------------------------
export abstract class ControllerImpl {
    parent: ViscometerUnitImpl
    options: ControllerOptions

    constructor(parent: ViscometerUnitImpl, options: ControllerOptions) {
        this.parent = parent
        this.options = options
    }

    protected defaultComponentOptions(): LADSComponentOptions {
        const componentOptions: LADSComponentOptions = {}
        this.options?.assetId ? componentOptions.assetId = this.options.assetId : 0
        this.options?.serialNumber ? componentOptions.serialNumber = this.options.serialNumber : 0
        return componentOptions
    }

    abstract start(): void;
    abstract stop(): void;
}

