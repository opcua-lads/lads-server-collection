// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2023 - 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
    ApplicationType, BonjourHolder, OPCUACertificateManager, OPCUAServer, OPCUAServerOptions, RegisterServerManagerMDNSONLY,
    RegisterServerMethod, setWarningLogger
} from "node-opcua"
import os from "os"
import { refreshSiteLocation } from "./lads-site-config"
import path from "path";
import { createServerAuthentication } from "./lads-users"
import { installRolePermissions } from "./lads-roles"

export interface CreateServerOptions {
    port?: number
    nodeset_filenames: string[]
    manufacturerName?: string
    applicationName: string
    applicationDirectory: string
    applicationUri?: string
    softwareVersion?: string
    uri: string
    certificateSupport?: boolean
    automaticallyAcceptUnknownCertificate?: boolean
    ldsSupport?: boolean
    increaseCapabilities?: boolean
}

// node-opcua logs "Cannot find reference to remove" for every instantiated node on deleteNode() (e.g. a deleted Result of an aborted run):
// type nodes keep no HasTypeDefinition back-references. This is harmless, so it is filtered out; all other warnings are still printed.
setWarningLogger((context: any, ...args: any[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("Cannot find reference to remove")) return
    console.warn(`${new Date().toISOString()} :${context?.filename} :${context?.callerline}`, ...args)
})

export function createServer(options: CreateServerOptions): OPCUAServer {
    refreshSiteLocation()    // background lookup of the site's GPS location (silent, cached in config/lads-site.json)
    // basic server options
    const serverOptions: OPCUAServerOptions = {
        port: options.port ?? 4850,
        buildInfo: {
            manufacturerName: options.manufacturerName ?? "AixEngineers",
            productName: options.uri,
            productUri: options.uri,
            softwareVersion: options.softwareVersion ?? "1.0.0",
        },
        serverInfo: {
            applicationName: options.applicationName,
            applicationType: ApplicationType.Server,
            productUri: options.uri,
            applicationUri: options.applicationUri ?? options.uri,

        },
        // nodesets used by the server
        nodeset_filename: options.nodeset_filenames,
    }

    // incerase server capabilities
    const increaseCapabilities = options.increaseCapabilities ?? true
    if (increaseCapabilities) {
        serverOptions.maxConnectionsPerEndpoint = 100
        serverOptions.serverCapabilities = {
            maxSessions: 100,
            maxSubscriptions: 1000,
            maxSubscriptionsPerSession: 50,
        }
    }
    
    // optional user name / password login and roles (config/lads-users.json); without users nothing changes
    const authentication = createServerAuthentication()
    if (authentication) {
        serverOptions.userManager = authentication.userManager
        serverOptions.allowAnonymous = authentication.allowAnonymous
        if (authentication.securityModes) serverOptions.securityModes = authentication.securityModes
        if (authentication.securityPolicies) serverOptions.securityPolicies = authentication.securityPolicies
        console.log(`${options.applicationName}: user login enabled (anonymous ${authentication.allowAnonymous ? "allowed" : "refused"}${authentication.securityModes ? ", secure endpoints only" : ""})`)
    }

    // support self signed certifcate 
    const certificateSupport = options.certificateSupport ?? true
    if (certificateSupport) {
        const automaticallyAcceptUnknownCertificate =  options.automaticallyAcceptUnknownCertificate ?? true
        const certRoot = path.join(options.applicationDirectory, "certs");
        serverOptions.serverCertificateManager = new OPCUACertificateManager({ rootFolder: certRoot, automaticallyAcceptUnknownCertificate });
        serverOptions.certificateFile = path.join(certRoot, "own", "certs", "certificate.pem");
        serverOptions.privateKeyFile = path.join(certRoot, "own", "private", "private_key.pem");
    }

    // support local discovery 
    const ldsSupport = options.ldsSupport ?? true
    if (ldsSupport) {
        serverOptions.registerServerMethod = RegisterServerMethod.MDNS
        serverOptions.capabilitiesForMDNS = ["DA", "HD", "AC", "DI"]
    }

    try {
        // build the server object
        const server = new OPCUAServer(serverOptions)
        if (ldsSupport) {
            // node-opcua's own mDNS manager announces the host as "TODO-find how to extract hostname" and uses the
            // applicationUri as instance name; replace it by one that announces <hostname>.local and a readable name
            server.registerServerManager = new LadsMdnsRegisterServerManager({ server }, options.applicationName)
            installShutdownService(server, options.applicationName)
        }
        if (authentication) installRolePermissions(server)
        return server
    }
    catch (err) {
        console.log(err)
        return undefined
    }
}
/**
 * DNS-SD instance name: readable, without dots (they would split the name into several DNS labels) and at most 63 bytes
 * (the limit of a DNS label).
 */
export function mdnsInstanceName(applicationName: string): string {
    let name = applicationName.replace(/\./g, " ").replace(/\s+/g, " ").trim()
    while (Buffer.byteLength(name, "utf8") > 63) name = name.slice(0, -1)
    return name
}

/**
 * The mDNS host name of ONE server: <computer>-<application>.local, for example macbook-pro-lads-ph-meter.local.
 * It must not be the host name of the computer itself: macOS (mDNSResponder) owns that name and renames the whole
 * computer ("MacBook-Pro-2") as soon as another process announces addresses for it, and several servers on one computer
 * would also fight over it. The name is unique, so there is no conflict. Resolvers treat only names below ".local" as
 * multicast names (os.hostname() has no ".local" on Windows and Linux); a DNS label has at most 63 bytes.
 */
export function mdnsHostName(applicationName: string): string {
    const label = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    const name = [label(os.hostname().split(".")[0]), label(applicationName)].filter((part) => part).join("-")
    return name.slice(0, 63).replace(/-+$/, "") + ".local"
}

/**
 * Announces the server on the multicast subnet like RegisterServerManagerMDNSONLY of node-opcua (service _opcua-tcp._tcp,
 * TXT caps and path), but with a usable host name and instance name. It is installed instead of the original manager,
 * so node-opcua starts it with the server and stops it on shutdown (mDNS goodbye).
 */
class LadsMdnsRegisterServerManager extends RegisterServerManagerMDNSONLY {
    private readonly announcement = new BonjourHolder()
    private readonly baseServer: OPCUAServer

    constructor(options: { server: OPCUAServer }, private readonly applicationName: string) {
        super(options)
        this.baseServer = options.server
    }

    override async start(): Promise<void> {
        await this.announcement.announcedOnMulticastSubnet({
            capabilities: this.baseServer.capabilitiesForMDNS,
            name: mdnsInstanceName(this.applicationName),
            path: "/",
            host: mdnsHostName(this.applicationName),
            port: this.baseServer.endpoints[0].port
        })
        this.emit("serverRegistered")
    }

    override async stop(): Promise<void> {
        await this.announcement.stopAnnouncedOnMulticastSubnet()
        this.emit("serverUnregistered")
    }

    override dispose(): void {
        // the base class asserts on its own (never started) holder; nothing else to release here
    }
}

// shutdown including sending mDNS goodbye message
function installShutdownService(server: OPCUAServer, name: string, signals = ['SIGINT', 'SIGTERM']): void {
    const shutdown = async (signal: string) => {
        console.log(`\n${signal} received, shutting down gracefully...`)
        try {
            await server.shutdown()
            console.log(`Server ${name} shutdown complete, mDNS goodbye sent.`)
            process.exit(0)
        } catch (err) {
            console.error("Error during shutdown:", err)
            process.exit(1)
        }
    }
    signals.forEach(signal => process.on(signal, () => shutdown(signal)))
}

