// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 * Role based access rights of the example servers. Active only when users are configured (see lads-users.ts).
 *
 *   Anonymous, AuthenticatedUser, Observer:  browse, read, history, events (read only)
 *   Operator:                                everything, except calling the methods of MachineryOperationMode state machines
 *   Engineer, Supervisor, ConfigureAdmin, SecurityAdmin:  everything
 *
 * The rights of the roles are applied as default of the server's own namespace(s); the exception (operation mode methods)
 * is set on the method nodes. A user gets the union of the rights of all of his roles (plus AuthenticatedUser).
 */

import { allPermissions, NodeClass, OPCUAServer, setNamespaceMetaData, PermissionFlag, RolePermissionTypeOptions, UAMethod, UAObject, UAObjectType, WellKnownRoles } from "node-opcua"

const ReadOnly = PermissionFlag.Browse | PermissionFlag.Read | PermissionFlag.ReadHistory | PermissionFlag.ReceiveEvents
const Everything = allPermissions
const NoCall = Everything & ~PermissionFlag.Call

type RoleRights = { [role in keyof typeof WellKnownRoles]: number }

const DefaultRights: RoleRights = {
    Anonymous: ReadOnly,
    AuthenticatedUser: ReadOnly,
    Observer: ReadOnly,
    Operator: Everything,
    Engineer: Everything,
    Supervisor: Everything,
    ConfigureAdmin: Everything,
    SecurityAdmin: Everything
}

const OperationModeMethodRights: RoleRights = { ...DefaultRights, Operator: NoCall }

function rolePermissions(rights: RoleRights): RolePermissionTypeOptions[] {
    return Object.entries(rights).map(([role, permissions]) => ({ roleId: WellKnownRoles[role as keyof typeof WellKnownRoles], permissions }))
}

/**
 * Default rights of the roles for all nodes of the server's namespaces that have no rights of their own, including nodes created
 * later (Results, ...). node-opcua evaluates the default through the NamespaceMetadata object of the namespace below Server/Namespaces;
 * the server's own namespace has none, so it is created here.
 */
export function applyDefaultRolePermissions(server: OPCUAServer): void {
    const addressSpace = server.engine.addressSpace
    const namespaces = addressSpace.rootFolder.objects.server.getChildByName("Namespaces") as any
    // namespace 0 stays open: the server object, the type system and the role set must be readable and are protected by their attributes
    for (let index = 1; index < addressSpace.getNamespaceArray().length; index++) {
        const namespace = addressSpace.getNamespace(index)
        if (!namespaces.getComponentByName(namespace.namespaceUri, namespace.index)) setNamespaceMetaData(namespace)
        namespace.setDefaultRolePermissions(rolePermissions(DefaultRights))
    }
}

/** the operator may not call the methods of MachineryOperationMode state machines (GotoMaintenance, GotoProcessing, ...) */
export function restrictOperationModeMethods(server: OPCUAServer): number {
    const addressSpace = server.engine.addressSpace
    let count = 0
    const modeType = addressSpace.findObjectType("MachineryOperationModeStateMachineType", addressSpace.getNamespaceIndex("http://opcfoundation.org/UA/Machinery/"))
    if (!modeType) return 0
    for (let index = 1; index < addressSpace.getNamespaceArray().length; index++) {
        for (const node of (addressSpace.getNamespace(index) as any).nodeIterator() as Iterable<any>) {
            if (node.nodeClass !== NodeClass.Object) continue
            const object = node as UAObject
            const type = (object as any).typeDefinitionObj as UAObjectType | undefined
            if (!type || type.nodeClass !== NodeClass.ObjectType || !type.isSubtypeOf(modeType)) continue
            for (const method of object.getMethods() as UAMethod[]) {
                method.setRolePermissions(rolePermissions(OperationModeMethodRights))
                count++
            }
        }
    }
    return count
}

/** installs the role rights; to be called once for a server that has users configured */
export function installRolePermissions(server: OPCUAServer): void {
    server.once("post_initialize", () => applyDefaultRolePermissions(server))
    // the servers build their structure after initialize() and before start(): the method nodes exist when start() has finished
    const start = server.start.bind(server) as (...args: any[]) => Promise<void>
    ;(server as any).start = async (...args: any[]) => {
        const result = await start(...args)
        const count = restrictOperationModeMethods(server)
        console.log(`Role based access: read only for Anonymous/Observer, operator may not call ${count} operation mode methods`)
        return result
    }
}
