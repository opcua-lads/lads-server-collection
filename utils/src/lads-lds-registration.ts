// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/*
 Registration of a server at the Local Discovery Server (OPC 10000-12, RegisterServer), in addition to its own mDNS announcement.

 RegisterServer (not RegisterServer2) on purpose: without a discovery configuration the LDS only lists the server in FindServers
 and does not announce it on mDNS a second time (the server announces itself). The registration is renewed every minute, so an
 LDS started later finds the server too; when no LDS runs, nothing happens (no log spam). At shutdown the server signs off.
 The LDS is opc.tcp://localhost:4840, or the environment variable LADS_LDS_URL.
*/

import {
    ApplicationType, MessageSecurityMode, OPCUAClientBase, OPCUAServer, RegisterServerRequest, RegisterServerResponse, SecurityPolicy,
    StatusCodes
} from "node-opcua"

const RenewInterval = 60_000

export class LdsRegistration {
    private timer?: NodeJS.Timeout
    private registered = false
    private readonly url: string

    constructor(private readonly server: OPCUAServer, private readonly applicationName: string) {
        this.url = process.env.LADS_LDS_URL ?? "opc.tcp://localhost:4840"
    }

    /** true when this server itself listens on the LDS port: then it would register at itself */
    private get isLdsPort(): boolean {
        try { return new URL(this.url).port === String(this.server.endpoints[0]?.port) && /localhost|127\.0\.0\.1/.test(this.url) }
        catch { return false }
    }

    start() {
        if (this.isLdsPort) return
        const renew = async () => {
            await this.register(true)
            this.timer = setTimeout(renew, RenewInterval)
        }
        this.timer = setTimeout(renew, 1000)
    }

    async stop() {
        if (this.timer) clearTimeout(this.timer)
        this.timer = undefined
        if (this.registered) await this.register(false)
    }

    private async register(isOnline: boolean) {
        const server = this.server
        const client = OPCUAClientBase.create({
            clientName: `${this.applicationName} -> LDS`,
            applicationName: this.applicationName,
            applicationUri: server.serverInfo.applicationUri ?? undefined,
            clientCertificateManager: server.serverCertificateManager,
            certificateFile: server.certificateFile,
            privateKeyFile: server.privateKeyFile,
            securityMode: MessageSecurityMode.SignAndEncrypt,
            securityPolicy: SecurityPolicy.Basic256Sha256,
            connectionStrategy: { maxRetry: 0, initialDelay: 100, maxDelay: 200 },
        })
        try {
            await client.connect(this.url)
            const request = new RegisterServerRequest({
                server: {
                    serverUri: server.serverInfo.applicationUri,
                    productUri: server.serverInfo.productUri,
                    serverNames: [{ locale: "en", text: this.applicationName }],
                    serverType: ApplicationType.Server,
                    discoveryUrls: [server.getEndpointUrl()],
                    isOnline,
                    gatewayServerUri: null,
                    semaphoreFilePath: null,
                },
            })
            const response = await new Promise<RegisterServerResponse>((resolve, reject) =>
                (client as any).performMessageTransaction(request, (err: Error | null, res: RegisterServerResponse) => err ? reject(err) : resolve(res)))
            const ok = response.responseHeader.serviceResult.equals(StatusCodes.Good)
            if (ok && isOnline && !this.registered) console.log(`${this.applicationName}: registered at the Local Discovery Server ${this.url}`)
            if (!ok) console.warn(`${this.applicationName}: registration at ${this.url} refused: ${response.responseHeader.serviceResult.toString()}`)
            this.registered = ok && isOnline
        }
        catch (err) {
            // no LDS running (or not reachable): try again at the next renewal, silently; report once when a registration is lost
            if (this.registered) console.log(`${this.applicationName}: Local Discovery Server ${this.url} not reachable any more`)
            this.registered = false
        }
        finally {
            try { await client.disconnect() } catch { /* already closed */ }
        }
    }
}
