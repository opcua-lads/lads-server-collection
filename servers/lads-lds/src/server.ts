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
 LADS Local Discovery Server (LDS-ME) on the well-known port 4840 (OPC 10000-12).

 - FindServers: the servers of this computer that registered themselves (every server made with createServer() does so with
   RegisterServer, see utils/src/lads-lds-registration.ts).
 - FindServersOnNetwork: every OPC UA server announced on the network by mDNS (_opcua-tcp._tcp), read by the LDS itself.
 - The LDS announces itself on mDNS with the capability "LDS".

 Clients like the Prosys OPC UA Browser ask the LDS at opc.tcp://<host>:4840 for the servers.

 Command line: --port <n> (default 4840).
*/

import os from "os"
import path from "path"
import {
    ApplicationType, MessageSecurityMode, OPCUACertificateManager, OPCUADiscoveryServer, RegisterServerRequest, RegisterServerResponse,
    SecurityPolicy, ServiceFault, StatusCode, StatusCodes
} from "node-opcua"
import { instanceApplicationUri, mdnsHostName, mdnsInstanceName } from "@utils"

/** A registration that was not renewed for this long is dropped (the servers renew every minute; a crashed one never signs off). */
const RegistrationTimeout = 3 * 60_000

/**
 * RegisterServer (without a discovery configuration) only lists the server for FindServers. node-opcua's LDS would also
 * announce it on mDNS (and fails on the empty mDNS name): the servers announce themselves, a second announcement is not wanted.
 */
class LadsDiscoveryServer extends OPCUADiscoveryServer {
    private readonly lastSeen = new Map<string, number>()

    protected override _on_RegisterServerRequest(message: any, channel: any): void {
        const request = message.request as RegisterServerRequest
        const server: any = request.server
        const reply = (response: RegisterServerResponse | ServiceFault) => channel.send_response("MSG", response, message)
        const fault = (code: StatusCode) => reply(new ServiceFault({ responseHeader: { serviceResult: code } }))
        if (!server?.serverUri) return fault(StatusCodes.BadServerUriInvalid)
        if (!server.serverNames?.length || !server.serverNames[0].text) return fault(StatusCodes.BadServerNameMissing)
        if (!server.discoveryUrls?.length || !server.discoveryUrls[0]) return fault(StatusCodes.BadDiscoveryUrlMissing)
        if (server.serverType === ApplicationType.Client) return fault(StatusCodes.BadInvalidArgument)
        const key: string = server.serverUri
        if (server.isOnline) {
            const firstTime = !this.registeredServers.has(key)
            server.serverInfo = {
                applicationName: server.serverNames[0], applicationType: server.serverType, applicationUri: key,
                discoveryUrls: server.discoveryUrls, gatewayServerUri: server.gatewayServerUri, productUri: server.productUri,
            }
            server.discoveryConfiguration = []
            this.registeredServers.set(key, server)
            this.lastSeen.set(key, Date.now())
            this.emit("onRegisterServer", server, firstTime)
        }
        else if (this.registeredServers.has(key)) {
            this.registeredServers.delete(key)
            this.lastSeen.delete(key)
            this.emit("onUnregisterServer", server, false)
        }
        reply(new RegisterServerResponse({}))
    }

    /** drops registrations that were not renewed in time */
    prune() {
        const now = Date.now()
        for (const [key, seen] of this.lastSeen) {
            if (now - seen < RegistrationTimeout) continue
            const server = this.registeredServers.get(key)
            this.registeredServers.delete(key)
            this.lastSeen.delete(key)
            if (server) this.emit("onUnregisterServer", server, true)
        }
    }
}

function argument(name: string): string | undefined {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : undefined
}

export async function main() {
    const port = Number(argument("--port") ?? 4840)
    const uri = "aixengineers.de/LADS-Discovery-Server"
    const applicationUri = instanceApplicationUri(uri, port)
    const certRoot = path.join(__dirname, "certs")
    const serverCertificateManager = new OPCUACertificateManager({ rootFolder: certRoot, automaticallyAcceptUnknownCertificate: true })

    const applicationName = `LADS Local Discovery Server (${os.hostname().split(".")[0]})`
    const server = new LadsDiscoveryServer({
        port,
        serverCertificateManager,
        certificateFile: path.join(certRoot, "own", "certs", `certificate-${port}.pem`),
        privateKeyFile: path.join(certRoot, "own", "private", "private_key.pem"),
        serverInfo: {
            applicationUri,
            productUri: uri,
            applicationName: { text: applicationName, locale: "en" },
        },
        // RegisterServer needs a secured channel; FindServers / FindServersOnNetwork / GetEndpoints work on None as well
        securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
        securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep],
    })
    server.on("onRegisterServer", (registered, firstTime) => {
        if (firstTime) console.log(`registered: ${registered.serverNames?.[0]?.text ?? registered.serverUri} (${registered.discoveryUrls?.join(", ")})`)
    })
    server.on("onUnregisterServer", (registered, forced) => {
        console.log(`unregistered${forced ? " (forced)" : ""}: ${registered.serverNames?.[0]?.text ?? registered.serverUri}`)
    })

    await server.start()
    // node-opcua announces the LDS under its applicationUri, which mDNS cuts at the first dot: announce it under a readable name
    // and its own host name, like the other servers (see createServer)
    const announcer = (server as any).mDnsLDSAnnouncer
    if (announcer) {
        await announcer.stopAnnouncedOnMulticastSubnet()
        await announcer.announcedOnMulticastSubnet({
            capabilities: ["LDS"], name: mdnsInstanceName(applicationName), path: "/DiscoveryServer", host: mdnsHostName("LADS Discovery Server"), port,
        })
    }
    setInterval(() => server.prune(), 60_000).unref()
    console.log(`LADS Local Discovery Server is ready on ${server.getEndpointUrl()} (${applicationUri})`)

    const shutdown = async (signal: string) => {
        console.log(`\n${signal} received, shutting down ...`)
        try { await server.shutdown() } finally { process.exit(0) }
    }
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(signal))
}

main().catch((err) => {
    console.error("LADS Local Discovery Server could not start:", err?.message ?? err)
    process.exit(1)
})
