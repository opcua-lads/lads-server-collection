// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 * User authentication (user name / password) and roles of the example servers.
 *
 * The configuration is optional. Without a file (config/lads-users.json, or the file named by LADS_USERS_CONFIG)
 * the servers behave as before: anonymous access, no user manager.
 *
 * {
 *   "allowAnonymous": true,                    // default true; false = login required
 *   "secureOnly": false,                       // true = only Sign / SignAndEncrypt endpoints (passwords never travel in clear text)
 *   "users": [
 *     { "name": "operator", "password": "scrypt$<salt hex>$<hash hex>", "roles": ["Operator"] }
 *   ]
 * }
 *
 * Passwords are stored as scrypt hashes, never in clear text. Create entries with: npm run user:add -- <name> <role[,role]>
 * Role names are the OPC UA well-known roles: Observer, Operator, Engineer, Supervisor, ConfigureAdmin, SecurityAdmin.
 */

import { existsSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { randomBytes, scryptSync, timingSafeEqual } from "crypto"
import { makeRoles, MessageSecurityMode, SecurityPolicy, UserManagerOptions, WellKnownRoles } from "node-opcua"
import type { NodeId } from "node-opcua"

export interface LADSUserEntry {
    name: string
    password: string        // scrypt$<salt hex>$<hash hex>
    roles?: string[]
}

export interface LADSUsersConfig {
    allowAnonymous?: boolean
    secureOnly?: boolean
    users?: LADSUserEntry[]
}

const KeyLength = 32

export function hashPassword(password: string): string {
    const salt = randomBytes(16)
    return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, KeyLength).toString("hex")}`
}

export function verifyPassword(password: string, stored: string): boolean {
    const [scheme, saltHex, hashHex] = (stored ?? "").split("$")
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false
    const expected = Buffer.from(hashHex, "hex")
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function usersConfigFile(): string {
    const candidates = [
        process.env.LADS_USERS_CONFIG,
        join(process.cwd(), "config", "lads-users.json"),
        resolve(__dirname, "..", "..", "config", "lads-users.json")
    ]
    return candidates.find(file => file && existsSync(file)) ?? join(process.cwd(), "config", "lads-users.json")
}

export function readUsersConfig(file = usersConfigFile()): LADSUsersConfig | undefined {
    if (!existsSync(file)) return undefined
    try {
        const config = JSON.parse(readFileSync(file, "utf8")) as LADSUsersConfig
        if (config.users !== undefined && !Array.isArray(config.users)) {
            console.warn(`User configuration ${file}: "users" must be an array of { name, password, roles }, ignored`)
            config.users = []
        }
        return config
    } catch (err) {
        console.warn(`User configuration ${file} ignored: ${err}`)
        return undefined
    }
}

export function writeUsersConfig(config: LADSUsersConfig, file = usersConfigFile()): void {
    writeFileSync(file, JSON.stringify(config, null, 4) + "\n", { mode: 0o600 })
}

function rolesOf(entry: LADSUserEntry | undefined): NodeId[] {
    const names = (entry?.roles ?? []).filter(name => name in WellKnownRoles)
    return names.length > 0 ? makeRoles(names.join(";")) : []
}

export interface ServerAuthentication {
    userManager: UserManagerOptions
    allowAnonymous: boolean
    securityModes?: MessageSecurityMode[]
    securityPolicies?: SecurityPolicy[]
}

/**
 * Server options for the configured users, or undefined if no users are configured (then nothing changes).
 */
export function createServerAuthentication(config = readUsersConfig()): ServerAuthentication | undefined {
    const users = config?.users ?? []
    if (users.length === 0) return undefined
    for (const entry of users) {
        for (const role of entry.roles ?? []) {
            if (!(role in WellKnownRoles)) console.warn(`User ${entry.name}: unknown role "${role}" ignored`)
        }
    }
    const known = (username: string) => users.find(entry => entry.name === username)
    const authentication: ServerAuthentication = {
        userManager: {
            isValidUser: (username: string, password: string) => {
                const entry = known(username)
                // a hash is computed in any case, so that unknown users cost the same time as wrong passwords
                const valid = verifyPassword(password, entry?.password ?? "scrypt$00$00")
                if (entry === undefined) console.warn(`Login refused: unknown user "${username}"`)
                else if (!valid) console.warn(`Login refused: wrong password for user "${username}"`)
                return valid && entry !== undefined
            },
            getUserRoles: (username: string) => rolesOf(known(username))
        },
        allowAnonymous: config.allowAnonymous ?? true
    }
    if (config.secureOnly) {
        authentication.securityModes = [MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt]
        authentication.securityPolicies = [SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep, SecurityPolicy.Aes256_Sha256_RsaPss]
    }
    return authentication
}
