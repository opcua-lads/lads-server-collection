// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2023 - 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { OPCUAServer } from "node-opcua"

// shutdown including sending mDNS goodbye message
export function installShutdownService(server: OPCUAServer, signals = ['SIGINT', 'SIGTERM']): void {
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

