// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Locks of the FUTURA Connect Xtra (DI LockingServices, as in the other LADS examples):

  - the device lock and one lock per functional unit (FUTURA, SPECTRA); a unit lock has the device lock as parent;
  - not locked: everybody with sufficient access rights may call the methods (StartProgram, Clear) and write the
    command TargetValues; locked: only the session that holds the lock (or the parent lock) may;
  - InitLock / RenewLock / ExitLock / BreakLock, RemainingLockTime and the lock events come from LockImpl (@utils).
*/

import { ISessionContext, UAObject, UAVariable } from "node-opcua"
import { UALockingServices } from "node-opcua-nodeset-di"
import { LockImpl, getLADSFunctionalUnits } from "@utils"
import { LADSDevice } from "@interfaces"

export type AccessPredicate = (context: ISessionContext) => boolean

export class FuturaLocks {
    readonly device?: LockImpl
    readonly units = new Map<string, LockImpl>()

    constructor(device: LADSDevice) {
        const deviceLock = (device as unknown as UAObject).getChildByName("Lock") as unknown as UALockingServices | null
        if (deviceLock) this.device = new LockImpl(deviceLock)
        for (const unit of getLADSFunctionalUnits(device)) {
            const lock = (unit as unknown as UAObject).getChildByName("Lock") as unknown as UALockingServices | null
            if (lock) this.units.set(unit.browseName.name!, new LockImpl(lock, this.device))
        }
    }

    /** May this session act on the unit (or on the device, without a unit name)? */
    isAccessibleBy(unit: string | undefined, context: ISessionContext): boolean {
        const lock = unit ? this.units.get(unit) : undefined
        if (lock) return lock.isAccessibleBy(context)
        return this.device ? this.device.isAccessibleBy(context) : true
    }

    predicate(unit?: string): AccessPredicate { return (context: ISessionContext) => this.isAccessibleBy(unit, context) }
}

/** A write of the variable is allowed only for sessions the predicate accepts (BadUserAccessDenied otherwise). */
export function restrictWriteAccess(variable: UAVariable | null | undefined, isAccessible: AccessPredicate) {
    if (!variable) return
    const original = variable.isUserWritable
    variable.isUserWritable = function (context: ISessionContext): boolean {
        return original.call(variable, context) && isAccessible(context)
    }
}
