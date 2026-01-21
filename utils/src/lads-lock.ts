// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2023 - 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AddressSpace, CallMethodResultOptions, coerceNodeId, DataType, IAddressSpace, ServerSession, SessionContext, StatusCode, StatusCodes, UAVariable, Variant, VariantLike } from "node-opcua";
import { UALockingServices } from "node-opcua-nodeset-di";
import { EventEmitter } from "stream";
import { getBooleanValue, getNumericValue, getStringValue, setBooleanValue, setNumericValue, setStringValue } from "./lads-variable-utils";
import { getDINamespace } from "./lads-utils";
import { assert } from "console";

export enum Duration {
    Second = 1000,
    Minute = 60 * Second,
    Hour = 60 * Minute,
    Day = 24 * Hour,
    Week = 7 * Day
}

export enum LockResult {
    OK = 0,
    NotLocked = -1,
    AlreadyLocked = -1,
    Invalid = -2,
}

export class LockImpl extends EventEmitter {
    static _maxInactiveLockTime: UAVariable = undefined

    static initialize(addressSpace: IAddressSpace, maxInactiveLockTime = 0) {
        if (this._maxInactiveLockTime != undefined) return
        const nsDI = getDINamespace(addressSpace).index
        this._maxInactiveLockTime = addressSpace.findNode(coerceNodeId(6387, nsDI)) as UAVariable
        this.maxInactiveLockTime = maxInactiveLockTime > 0 ? maxInactiveLockTime: Duration.Minute
    }
    static set maxInactiveLockTime(duration: number) { setNumericValue(this._maxInactiveLockTime, duration) }
    static get maxInactiveLockTime(): number { return getNumericValue(this._maxInactiveLockTime) }

    lock: UALockingServices
    context: string = ""
    sessionContext: SessionContext = undefined
    timeout: NodeJS.Timeout = undefined
    timestampExpired: number
    parentLock: LockImpl

    constructor(lock: UALockingServices, parentLock: LockImpl = undefined) {
        super()
        assert(lock != undefined)

        LockImpl.initialize(lock.addressSpace)
        this.lock = lock
        lock.initLock?.bindMethod(this.initLock.bind(this))
        lock.renewLock?.bindMethod(this.renewLock.bind(this))
        lock.exitLock?.bindMethod(this.exitLock.bind(this))
        lock.breakLock?.bindMethod(this.breakLock.bind(this))
        lock.remainingLockTime?.bindVariable({ get: () => { return new Variant({ dataType: DataType.Double, value: this.remainingLockTime }) } }, true)
        this.parentLock = parentLock
    }

    isAccessibleBy(sessionContext: SessionContext): boolean {
        // eventually renew lock on every call
        if (this.locked && (this.sessionContext === sessionContext)) {           
            this.renewTimer()
        }
        // check optional parent lock
        if (!(this.parentLock ? this.parentLock.isAccessibleBy(sessionContext) : true))
            return false
        // check local local
        return this.locked ? this.sessionContext === sessionContext : true
    }

    get locked(): boolean { return getBooleanValue(this.lock.locked, false) }
    private set locked(value: boolean) { setBooleanValue(this.lock.locked, value) }
    get lockingClient(): string { return getStringValue(this.lock.lockingClient) }
    get lockingUser(): string { return getStringValue(this.lock.lockingUser) }
    get remainingLockTime(): number { return this.locked ? this.timestampExpired - Date.now() : 0 }

    private startTimer(sessionContext: SessionContext) {
        this.locked = true
        this.sessionContext = sessionContext
        const session = sessionContext.session as ServerSession
        const userIdentity = sessionContext.userIdentity
        const applicationUri: string = session.clientDescription?.applicationUri ? session.clientDescription.applicationUri : ""
        const applicationName: string = session.clientDescription?.applicationName ? session.clientDescription?.applicationName.text : ""
        setStringValue(this.lock.lockingUser, userIdentity)
        //setStringValue(this.lock.lockingClient, `ApplicationName: ${applicationName}, ApplicationURI: ${applicationUri}`)
        setStringValue(this.lock.lockingClient, `${applicationName}`)
        this.renewTimer()
    }

    private renewTimer() {
        if (!this.locked) return
        if (this.timeout) clearTimeout(this.timeout)
        this.timestampExpired = Date.now() + LockImpl.maxInactiveLockTime
        this.timeout = setTimeout(() => { this.stopTimer() }, LockImpl.maxInactiveLockTime)
    }

    private stopTimer() {
        this.locked = false
        this.sessionContext = undefined
        this.context = ""
        setStringValue(this.lock.lockingUser, "")
        setStringValue(this.lock.lockingClient, "")
        clearTimeout(this.timeout)
    }

    static methodResult(options: { statusCode?: StatusCode, result: LockResult }): CallMethodResultOptions {
        return {
            statusCode: options.statusCode ? options.statusCode : StatusCodes.Good,
            outputArguments: [new Variant({ dataType: DataType.Int32, value: options.result })]
        }
    }

    private async initLock(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (this.locked) return LockImpl.methodResult({ result: LockResult.AlreadyLocked })
        this.context = inputArguments[0].value
        this.startTimer(context)
        return LockImpl.methodResult({ result: LockResult.OK })
    }

    private async renewLock(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.locked) return LockImpl.methodResult({ result: LockResult.NotLocked })
        if (context != this.sessionContext) return { statusCode: StatusCodes.BadLocked }
        this.startTimer(context)
        return LockImpl.methodResult({ result: LockResult.OK })
    }

    private async exitLock(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.locked) return LockImpl.methodResult({ result: LockResult.NotLocked })
        if (context != this.sessionContext) return { statusCode: StatusCodes.BadLocked }
        this.stopTimer()
        return LockImpl.methodResult({ result: LockResult.OK })
    }

    private async breakLock(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        if (!this.locked) LockImpl.methodResult({ result: LockResult.NotLocked })
        this.stopTimer()
        return LockImpl.methodResult({ result: LockResult.OK })
    }
}

