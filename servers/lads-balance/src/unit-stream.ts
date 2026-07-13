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
import { BalanceTransport, SerialBalanceTransport, TcpBalanceTransport } from './balance-transport';

//---------------------------------------------------------------
type Parity = "none" | "even" | "odd" | "mark" | "space";

function createTransport(config: BalanceDeviceConfig): BalanceTransport {
    const port = config.serialPort.trim()
    const isUrl = port.includes("://")
    if (isUrl) {
        const url = new URL(port)
        return new TcpBalanceTransport({
            host: url.hostname, 
            port: Number(url.port)
        })
    } else {
        return new SerialBalanceTransport({
            path: config.serialPort,
            baudRate: config.baudRate ?? 9600,
            parity: (config.parity ?? "none") as Parity,
            dataBits: config.dataBits ?? 8,
            stopBits: config.stopBits ?? 1,
        })
    }
        
}
export class SerialBalanceUnitImpl extends BalanceUnitImpl {

    constructor(parent: BalanceDeviceImpl, functionalUnitSet: BalanceFunctionalUnitSet, config: BalanceDeviceConfig) {
        const protocol = config.protocol
        const sics = (protocol === BalanceProtocols.SICS)
        const optionals = sics ? BalanceTareOptionals : []
        super(parent, config, optionals)
        
        // create balance
        const transport: BalanceTransport = createTransport(config)
        if (sics) {
            this.balance = new SicsBalance(transport)
        } else {
            this.balance = new SbiBalance(transport)
        }
        
        // finalize iitialization
        this.postInitialize()
    }
}
