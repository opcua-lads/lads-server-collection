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

import { BalanceFunctionalUnitSet, BalanceTareOptionals } from './interfaces';
import { BalanceDeviceImpl } from './device';
import { BalanceUnitImpl } from './unit';
import { BalanceDeviceConfig, BalanceProtocols } from './server';
import { SbiBalance } from './balance-sbi';
import { SicsBalance } from './balance-sics';
import { SerialPortOpenOptions } from 'serialport';

//---------------------------------------------------------------
export class SerialBalanceUnitImpl extends BalanceUnitImpl {

    constructor(parent: BalanceDeviceImpl, functionalUnitSet: BalanceFunctionalUnitSet, config: BalanceDeviceConfig) {
        const protocol = config.protocol
        const sics = (protocol === BalanceProtocols.SICS)
        const optionals = sics ? BalanceTareOptionals : []
        super(parent, optionals)
        
        // create balance
        const options: SerialPortOpenOptions<any> = {
            path: config.serialPort,
            baudRate: config.baudRate ?? 9600,
            parity: config.parity ?? "none",
            dataBits: config.dataBits ?? 8,
            stopBits: config.stopBits ?? 1,
        }
        if (sics) {
            this.balance = new SicsBalance(options)
        } else {
            this.balance = new SbiBalance(options)
        }
        
        // finalize iitialization
        this.postInitialize()
    }


}
