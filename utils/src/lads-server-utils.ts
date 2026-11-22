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
    Subscription,
    ApplicationType, BonjourHolder, OPCUACertificateManager, OPCUAServer, OPCUAServerOptions, RegisterServerManagerMDNSONLY,
    RegisterServerMethod, setWarningLogger
} from "node-opcua"
import os from "os"
import fs from "fs"
import dns from "dns"
import { exploreCertificate, readCertificate } from "node-opcua-crypto"
import { refreshSiteLocation } from "./lads-site-config"
import path from "path";
import { createServerAuthentication } from "./lads-users"
import { installRolePermissions } from "./lads-roles"
import { LdsRegistration } from "./lads-lds-registration"

/**
 * node-opcua determines the fully qualified host name once per process with a reverse DNS lookup of the computer's own
 * address (dns.lookupService). Without a DNS server that answers it (e.g. after a VPN went down) this waits 30 s for the
 * timeout, and node-opcua then uses os.hostname() anyway. Limit the reverse lookup to 2 s: same result, no 30 s start.
 */
const ReverseLookupTimeout = 2000
const originalLookupService = dns.lookupService
;(dns as any).lookupService = (address: string, port: number, callback: (err: Error | null, hostname?: string, service?: string) => void) => {
    let done = false
    const timer = setTimeout(() => {
        if (done) return
        done = true
        callback(Object.assign(new Error(`reverse DNS lookup of ${address} timed out`), { code: "ETIMEOUT" }))
    }, ReverseLookupTimeout)
    originalLookupService.call(dns, address, port, (err: Error | null, hostname: string, service: string) => {
        if (done) return
        done = true
        clearTimeout(timer)
        callback(err, hostname, service)
    })
}

export interface CreateServerOptions {
    port?: number
    nodeset_filenames: string[]
    manufacturerName?: string
    applicationName: string
    applicationDirectory: string
    /** Identifies this server instance (OPC 10000-4, 7.2). Default: urn:<host>:<uri>:<serialNumber or port>. */
    applicationUri?: string
    /** Serial number of the instance, part of the default applicationUri (otherwise the port). */
    serialNumber?: string
    softwareVersion?: string
    /** Identifies the product (productUri, the same for every instance) */
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

/**
 * The applicationUri of a server instance. OPC 10000-4, 7.2: "The globally unique identifier for the application instance";
 * the productUri (7.31) identifies the product and is the same for all instances. Host and serial number (or port) make
 * several instances of one product distinct, on one computer and across computers.
 */
export function instanceApplicationUri(uri: string, instance: string | number): string {
    const host = os.hostname().split(".")[0].toLowerCase()
    return `${productUriOf(uri)}:${host}:${instance}`
}

/** Readable product name: "aixengineers.de/LADS-Freezer-Server" and "LADS-Freezer-Server" both give "LADS-Freezer-Server". */
export function productNameOf(uri: string): string {
    return uri.replace(/^urn:[^:]+:/i, "").replace(/^.*\//, "")
}

/**
 * productUri (OPC 10000-4, 7.31: "the globally unique identifier for the Server product"), the same form for every server:
 * urn:aixengineers.de:<product name>. A value that already has a URI scheme (urn:, http:, ...) is kept.
 */
export function productUriOf(uri: string): string {
    return /^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `urn:aixengineers.de:${productNameOf(uri)}`
}

/**
 * Further host names of the endpoints besides the computer name: <name>.local (resolvable by mDNS) and the IPv4 addresses of
 * the network interfaces. A client in another subnet (e.g. a VM) cannot resolve the bare computer name, and a client that
 * connects by IP address finds no matching endpoint without them.
 */
export function alternateHostnames(): string[] {
    const names = new Set<string>([`${os.hostname().split(".")[0]}.local`])
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === "IPv4" && !address.internal) names.add(address.address)
        }
    }
    return [...names]
}

/**
 * GetEndpoints for a host name the server does not know (e.g. "localhost", while the endpoints carry the computer name,
 * <name>.local and the IP addresses): node-opcua then returns the endpoints of ALL host names, but CreateSession only those
 * of the chosen one, and strict clients (.NET stack, gateway) refuse the session: "Server did not return a number of
 * ServerEndpoints that matches the one from GetEndpoints" (BadSecurityChecksFailed). OPC 10000-4, GetEndpoints: "The Server
 * should return a suitable default URL if it does not recognize the HostName in the URL" - so answer for the primary host name.
 */
function installDefaultEndpointUrl(server: OPCUAServer) {
    const target = server as any
    const original = target._on_GetEndpointsRequest.bind(server)
    target._on_GetEndpointsRequest = (message: any, channel: any) => {
        const request = message.request
        const endpoints: { endpointUrl?: string | null }[] = target._get_endpoints(null)
        if (request?.endpointUrl && endpoints.length && !endpoints.some((e) => e.endpointUrl === request.endpointUrl)) {
            request.endpointUrl = endpoints[0].endpointUrl
        }
        original(message, channel)
    }
}

/** node-opcua creates the server certificate only when the file is missing; one issued for another applicationUri is set aside. */
/** Subject of the self-signed application instance certificates (node-opcua's default is O=Sterfive/L=Orleans/C=FR) */
export const CertificateOrganization = "AixEngineers"
export const CertificateSubject = `/O=${CertificateOrganization}/L=Aachen/C=DE`
OPCUACertificateManager.defaultCertificateSubject = CertificateSubject

/**
 * dNSNames of the certificate (OPC 10000-6, 6.2.2: servers shall specify a dNSName or a static IPAddress of the machine):
 * the computer name and <name>.local, both stable. IP addresses are left out on purpose: they change (DHCP, VPN), and the
 * host name check of the clients may be suppressed (OPC 10000-4, 6.1.3), the URI check may not.
 */
export function certificateDnsNames(): string[] {
    const short = os.hostname().split(".")[0]
    return [...new Set([os.hostname(), short, `${short}.local`])]
}

/** node-opcua creates a missing certificate with its own host names; this one uses certificateDnsNames and CertificateSubject. */
export function installCertificateFactory(server: any) {
    server.createDefaultCertificate = async function () {
        if (fs.existsSync(this.certificateFile)) return
        const name = coerceText(this.serverInfo.applicationName) ?? "LADS Server"
        const commonName = `${name}@${os.hostname().split(".")[0]}`.substring(0, 63)
        await this.serverCertificateManager.createSelfSignedCertificate({
            applicationUri: this.serverInfo.applicationUri,
            dns: certificateDnsNames(),
            outputFile: this.certificateFile,
            subject: `/CN=${commonName}${CertificateSubject}`,
            startDate: new Date(),
            validity: 365 * 10,
        })
    }
}

function coerceText(text: any): string | undefined {
    return typeof text === "string" ? text : text?.text ?? undefined
}

export function dropStaleCertificate(certificateFile: string, applicationUri: string) {
    if (!fs.existsSync(certificateFile)) return
    try {
        const tbs = exploreCertificate(readCertificate(certificateFile)).tbsCertificate
        const uris = tbs.extensions?.subjectAltName?.uniformResourceIdentifier ?? []
        const dns: string[] = tbs.extensions?.subjectAltName?.dNSName ?? []
        const reason = !uris.includes(applicationUri) ? `was issued for ${uris.join(", ") || "no URI"}`
            : tbs.subject?.organizationName !== CertificateOrganization ? `was issued by ${tbs.subject?.organizationName ?? "unknown"}`
            : certificateDnsNames().some((name) => !dns.includes(name)) ? `lacks host names (has ${dns.join(", ")})`
            : undefined
        if (!reason) return
        fs.renameSync(certificateFile, `${certificateFile}.${Date.now()}.old`)
        console.log(`server certificate ${reason}; a new one is created for ${applicationUri}`)
    }
    catch (err) {
        console.warn(`server certificate ${certificateFile} could not be checked: ${err}`)
    }
}

/**
 * node-opcua asserts in Subscription.adjustSamplingInterval when the monitored node has a MinimumSamplingInterval outside
 * [0, maximumSamplingInterval] (e.g. -1, "indeterminate", which the spec allows). A client that re-creates its monitored
 * items with NodeIds of an older address space (the server was restarted with a changed model) can hit such a node, and the
 * assert ends the whole server. Guard: on such a node the publishing interval of the subscription is used instead.
 */
let samplingGuardInstalled = false
export function installSamplingIntervalGuard() {
    if (samplingGuardInstalled) return
    samplingGuardInstalled = true
    const proto = Subscription.prototype as any
    const adjust = proto.adjustSamplingInterval as (samplingInterval: number, node?: unknown) => number
    proto.adjustSamplingInterval = function (samplingInterval: number, node?: unknown): number {
        try {
            return adjust.call(this, samplingInterval, node)
        } catch (err) {
            const id = (node as any)?.nodeId?.toString?.() ?? "?"
            console.warn(`Monitored item on ${id}: invalid MinimumSamplingInterval, using the publishing interval (${this.publishingInterval} ms)`)
            return this.publishingInterval
        }
    }
}

export function createServer(options: CreateServerOptions): OPCUAServer {
    installSamplingIntervalGuard()
    refreshSiteLocation()    // background lookup of the site's GPS location (silent, cached in config/lads-site.json)
    const port = options.port ?? 4850
    const applicationUri = options.applicationUri ?? instanceApplicationUri(options.uri, options.serialNumber ?? port)
    // basic server options
    const serverOptions: OPCUAServerOptions = {
        port,
        alternateHostname: alternateHostnames(),
        buildInfo: {
            manufacturerName: options.manufacturerName ?? "AixEngineers",
            productName: productNameOf(options.uri),
            productUri: productUriOf(options.uri),
            softwareVersion: options.softwareVersion ?? "1.0.0",
        },
        serverInfo: {
            applicationName: options.applicationName,
            applicationType: ApplicationType.Server,
            productUri: productUriOf(options.uri),
            applicationUri,

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
        // one certificate per instance (several instances of a server share the application directory)
        serverOptions.certificateFile = path.join(certRoot, "own", "certs", `certificate-${port}.pem`);
        dropStaleCertificate(serverOptions.certificateFile, applicationUri)
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
        installCertificateFactory(server)
        installDefaultEndpointUrl(server)
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
    private readonly lds: LdsRegistration

    constructor(options: { server: OPCUAServer }, private readonly applicationName: string) {
        super(options)
        this.baseServer = options.server
        this.lds = new LdsRegistration(options.server, applicationName)
    }

    override async start(): Promise<void> {
        await this.announcement.announcedOnMulticastSubnet({
            capabilities: this.baseServer.capabilitiesForMDNS,
            name: mdnsInstanceName(this.applicationName),
            path: "/",
            host: mdnsHostName(this.applicationName),
            port: this.baseServer.endpoints[0].port
        })
        this.lds.start()   // also listed by the Local Discovery Server (FindServers), when one runs
        this.emit("serverRegistered")
    }

    override async stop(): Promise<void> {
        await this.lds.stop()
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

