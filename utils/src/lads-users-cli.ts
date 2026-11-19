// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 * Adds or changes a user in config/lads-users.json:   npm run user:add -- <name> [role[,role]]
 * Removes a user:                                      npm run user:add -- --remove <name>
 * The password is asked without echo, so it does not end up in the shell history.
 */

import { createInterface } from "readline"
import { WellKnownRoles } from "node-opcua"
import { hashPassword, readUsersConfig, usersConfigFile, writeUsersConfig } from "./lads-users"

function askHidden(prompt: string): Promise<string> {
    return new Promise(resolvePassword => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
        const write = (rl as any)._writeToOutput
        ;(rl as any)._writeToOutput = (text: string) => { if (text.includes(prompt)) write.call(rl, text) }
        rl.question(prompt, answer => { rl.close(); process.stdout.write("\n"); resolvePassword(answer) })
    })
}

async function main() {
    const args = process.argv.slice(2)
    const file = usersConfigFile()
    const config = readUsersConfig(file) ?? {}
    config.users = config.users ?? []

    if (args[0] === "--remove" && args[1]) {
        config.users = config.users.filter(user => user.name !== args[1])
        writeUsersConfig(config, file)
        console.log(`User ${args[1]} removed (${file})`)
        return
    }
    const [name, rolesArg] = args
    if (!name) {
        console.log(`usage: npm run user:add -- <name> [role[,role]]    roles: ${Object.keys(WellKnownRoles).filter(k => isNaN(Number(k))).join(", ")}`)
        process.exit(1)
    }
    const roles = (rolesArg ?? "Operator").split(",").map(role => role.trim()).filter(role => role)
    const unknown = roles.filter(role => !(role in WellKnownRoles))
    if (unknown.length > 0) {
        console.error(`Unknown role(s): ${unknown.join(", ")}`)
        process.exit(1)
    }
    const password = await askHidden("Password: ")
    if (!password || password !== await askHidden("Repeat password: ")) {
        console.error("Passwords empty or different, nothing changed")
        process.exit(1)
    }
    const entry = { name, password: hashPassword(password), roles }
    const index = config.users.findIndex(user => user.name === name)
    if (index >= 0) config.users[index] = entry
    else config.users.push(entry)
    writeUsersConfig(config, file)
    console.log(`User ${name} (${roles.join(", ")}) saved in ${file}`)
}

main()
