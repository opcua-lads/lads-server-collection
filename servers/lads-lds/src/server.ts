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
    ApplicationDescription, ApplicationType, MessageSecurityMode, OPCUACertificateManager, OPCUADiscoveryServer, RegisterServerRequest, RegisterServerResponse,
    SecurityPolicy, ServiceFault, StatusCode, StatusCodes
} from "node-opcua"
import { alternateHostnames, dropStaleCertificate, installCertificateFactory, instanceApplicationUri, mdnsHostName, mdnsInstanceName, productUriOf } from "@utils"

/** A registration that was not renewed for this long is dropped (the servers renew every minute; a crashed one never signs off). */
const RegistrationTimeout = 3 * 60_000

/**
 * RegisterServer (without a discovery configuration) only lists the server for FindServers. node-opcua's LDS would also
 * announce it on mDNS (and fails on the empty mDNS name): the servers announce themselves, a second announcement is not wanted.
 */
/** host of an opc.tcp URL, lower case ("opc.tcp://[::1]:4840/x" gives "::1") */
function hostOf(url?: string | null): string | undefined {
    return url ? /^opc\.tcp:\/\/\[?([^\]/:]+)/i.exec(url)?.[1]?.toLowerCase() : undefined
}

/**
 * The discovery URLs of a server that fit the host name the client used to reach the LDS (OPC 10000-4, FindServers: the
 * endpointUrl tells the server which URLs to return): the same host name or IP address; localhost gives the computer name.
 * Unknown host: all URLs. So a client gets one reachable address per server instead of one per network interface.
 */
function urlsFor(urls: string[], clientHost?: string): string[] {
    if (!clientHost) return urls
    const local = ["localhost", "127.0.0.1", "::1"].includes(clientHost)
    const wanted = local ? os.hostname().split(".")[0].toLowerCase() : clientHost
    const fitting = urls.filter((url) => hostOf(url) === wanted)
    return fitting.length ? fitting : urls
}

class LadsDiscoveryServer extends OPCUADiscoveryServer {
    private readonly lastSeen = new Map<string, number>()
    /** per secure channel: the host name the client used (from the endpointUrl of its requests) */
    private readonly clientHosts = new WeakMap<object, string>()

    override getServers(channel: any): ApplicationDescription[] {
        const host = this.clientHosts.get(channel)
        return super.getServers(channel).map((server: any) => {
            const urls: string[] = server.discoveryUrls ?? []
            const fitting = urlsFor(urls, host)
            if (fitting.length === urls.length) return server
            return new ApplicationDescription({
                applicationName: server.applicationName, applicationType: server.applicationType, applicationUri: server.applicationUri,
                discoveryProfileUri: server.discoveryProfileUri, gatewayServerUri: server.gatewayServerUri, productUri: server.productUri,
                discoveryUrls: fitting,
            })
        })
    }

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

    /**
     * Logs who asks the LDS: FindServers / FindServersOnNetwork always, GetEndpoints from other computers (the registration
     * clients of the local servers call GetEndpoints every minute). Shows at once whether a client (Prosys, UaExpert in a VM)
     * reaches the LDS at all.
     */
    override on_request(message: any, channel: any): void {
        const name: string = message?.request?.schema?.name ?? ""
        const requestHost = hostOf(message?.request?.endpointUrl)
        if (requestHost && channel) this.clientHosts.set(channel, requestHost)
        const from = String(channel?.remoteAddress ?? "?").replace(/^::ffff:/, "")
        const local = from === "127.0.0.1" || from === "::1"
        if (name === "FindServersRequest" || name === "FindServersOnNetworkRequest" || (name === "GetEndpointsRequest" && !local)) {
            const url = message.request.endpointUrl ? ` (endpointUrl ${message.request.endpointUrl})` : ""
            console.log(`${new Date().toISOString()} ${name.replace(/Request$/, "")} from ${from}${url}: ${this.registeredServers.size} registered servers`)
        }
        super.on_request(message, channel)
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
    const certificateFile = path.join(certRoot, "own", "certs", `certificate-${port}.pem`)
    dropStaleCertificate(certificateFile, applicationUri)   // a certificate issued for another applicationUri is created anew

    const applicationName = `LADS Local Discovery Server (${os.hostname().split(".")[0]})`
    const server = new LadsDiscoveryServer({
        port,
        alternateHostname: alternateHostnames(),   // reachable by <name>.local and IP address (clients in other subnets, VMs)
        serverCertificateManager,
        certificateFile,
        privateKeyFile: path.join(certRoot, "own", "private", "private_key.pem"),
        serverInfo: {
            applicationUri,
            productUri: productUriOf(uri),
            applicationName: { text: applicationName, locale: "en" },
        },
        // RegisterServer needs a secured channel; FindServers / FindServersOnNetwork / GetEndpoints work on None as well
        securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
        securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep],
    })
    installCertificateFactory(server)   // subject AixEngineers, host names incl. <name>.local
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
