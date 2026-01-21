// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2023 - 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ApplicationType, OPCUACertificateManager, OPCUAServer, OPCUAServerOptions, RegisterServerMethod } from "node-opcua"
import path from "path";

export interface CreateServerOptions {
    port?: number
    nodeset_filenames: string[]
    manufacturerName?: string
    applicationName: string
    softwareVersion?: string
    uri: string
    certificateSupport?: boolean
    ldsSupport?: boolean
    increaseCapabilities?: boolean
}

export function createServer(options: CreateServerOptions): OPCUAServer {
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
            applicationUri: options.uri,

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
    
    // support self signed certifcate 
    const certificateSupport = options.certificateSupport ?? true
    if (certificateSupport) {
        const certRoot = path.join(process.cwd(), "certs");
        serverOptions.serverCertificateManager = new OPCUACertificateManager({ rootFolder: certRoot });
        serverOptions.certificateFile = path.join(certRoot, "own", "certs", "certificate.pem");
        serverOptions.privateKeyFile = path.join(certRoot, "own", "private", "private_key.pem");
    }

    // support local discovery 
    const ldsSupport = options.ldsSupport ?? true
    if (options.ldsSupport) {
        serverOptions.registerServerMethod = RegisterServerMethod.MDNS
        serverOptions.capabilitiesForMDNS = ["DA", "HD", "AC", "DI"]
    }

    try {
        // build the server object
        const server = new OPCUAServer(serverOptions)
        if (ldsSupport) installShutdownService(server)
        return server
    }
    catch (err) {
        console.log(err)
        return undefined
    }
}
// shutdown including sending mDNS goodbye message
function installShutdownService(server: OPCUAServer, signals = ['SIGINT', 'SIGTERM']): void {
    const shutdown = async (signal: string) => {
        console.log(`\n${signal} received, shutting down gracefully...`)
        try {
            await server.shutdown()
            console.log("Server shutdown complete, mDNS goodbye sent.")
            process.exit(0)
        } catch (err) {
            console.error("Error during shutdown:", err)
            process.exit(1)
        }
    }
    signals.forEach(signal => process.on(signal, () => shutdown(signal)))
}

