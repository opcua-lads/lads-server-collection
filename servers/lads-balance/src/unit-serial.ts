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

import { BalanceFunctionalUnit } from './interfaces';
import { BalanceDeviceImpl } from './device';
import { BalanceUnitImpl } from './unit';
import { BalanceDeviceConfig, BalanceProtocols } from './server';
import { SbiBalance } from './balance-sbi';
import { SicsBalance } from './balance-sics';

//---------------------------------------------------------------
export class SerialBalanceUnitImpl extends BalanceUnitImpl {

    constructor(parent: BalanceDeviceImpl, functionalUnit: BalanceFunctionalUnit, config: BalanceDeviceConfig) {
        super(parent, functionalUnit)

        // create balance
        const protocol = config.protocol
        const port = config.serialPort
        if (protocol === BalanceProtocols.SBI) {
            this.balance = new SbiBalance(port)
        } else {
            this.balance = new SicsBalance(port)
        }
        
        // finalize iitialization
        this.postInitialize()
    }


}
