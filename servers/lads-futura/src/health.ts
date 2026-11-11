// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Device health of the FUTURA Connect Xtra.

The StatusFlags register (Inst. 2) sits on the device next to DeviceHealth. Each status bit that is modelled as an alarm drives one
alarm of DeviceHealthAlarms (DI FailureAlarmType, OffSpecAlarmType or MaintenanceRequiredAlarmType) whose source is the affected
component; DeviceHealth is the worst value of all active alarms (NAMUR NE 107).

For simulation the object Simulator has a writable variable StatusFlags. Writing it sets the register and, derived from it,
  - an event for every alarm that becomes active (or inactive)
  - DeviceHealth, and an event whenever DeviceHealth changes
*/

import { AddressSpace, DataType, Namespace, QualifiedName, ReferenceTypeIds, UAObject, UAVariable, AccessLevelFlag, StatusCodes, Variant, makeNodeId } from "node-opcua"
import { EnumDeviceHealth } from "node-opcua-nodeset-di"
import { EventSeverity, raiseEvent } from "@utils"

/**
 * Readable display name from a camel case browse name: a space before every upper case letter except the first;
 * runs of capitals stay together (EURange -> EU Range, ColeColeAlpha -> Cole Cole Alpha).
 * Same rule as display_name() of nodesets/generators/gen_futura.py.
 */
export function displayNameFromBrowseName(browseName: string): string {
    return browseName.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g, " ")
}

interface AlarmDefinition { name: string, bit: number, component: "Probe" | "Futura" | "Spectra", health: EnumDeviceHealth, severity: number, description: string }

const ALARMS: AlarmDefinition[] = [
    { name: "FuturaCapacitanceOutOfRange", bit: 0, component: "Futura", health: EnumDeviceHealth.OFF_SPEC, severity: 300, description: "Capacitance out of range" },
    { name: "FuturaConductivityOutOfRange", bit: 1, component: "Futura", health: EnumDeviceHealth.OFF_SPEC, severity: 300, description: "Conductivity out of range" },
    { name: "ProbeTemperatureOutOfRange", bit: 2, component: "Probe", health: EnumDeviceHealth.OFF_SPEC, severity: 300, description: "Temperature out of range" },
    { name: "ProbeLeakage", bit: 3, component: "Probe", health: EnumDeviceHealth.MAINTENANCE_REQUIRED, severity: 300, description: "Probe leakage" },
    { name: "CleanLeakage", bit: 4, component: "Probe", health: EnumDeviceHealth.MAINTENANCE_REQUIRED, severity: 300, description: "Clean leakage" },
    { name: "FuturaMemoryFileMissing", bit: 6, component: "Futura", health: EnumDeviceHealth.FAILURE, severity: 600, description: "FUTURA memory, file missing" },
    { name: "ProbeMemoryFileMissing", bit: 7, component: "Probe", health: EnumDeviceHealth.FAILURE, severity: 600, description: "Probe memory, file missing" },
    { name: "NoProbe", bit: 9, component: "Probe", health: EnumDeviceHealth.FAILURE, severity: 600, description: "No probe" },
    { name: "SpectraCurveFitError", bit: 12, component: "Spectra", health: EnumDeviceHealth.OFF_SPEC, severity: 300, description: "Curve fit error" },
]
const SIGNAL_SIMULATOR_BIT = 10

/** NAMUR NE 107 priority: higher is worse */
const PRIORITY: Record<number, number> = {
    [EnumDeviceHealth.NORMAL]: 0,
    [EnumDeviceHealth.MAINTENANCE_REQUIRED]: 1,
    [EnumDeviceHealth.OFF_SPEC]: 2,
    [EnumDeviceHealth.CHECK_FUNCTION]: 3,
    [EnumDeviceHealth.FAILURE]: 4,
}

/** severity of the DeviceHealth event: like the alarms (Failure 600, other abnormal states 300), Normal is Info */
function healthSeverity(health: EnumDeviceHealth): number {
    if (health === EnumDeviceHealth.NORMAL) return EventSeverity.Info
    return health === EnumDeviceHealth.FAILURE ? EventSeverity.Alarm : EventSeverity.Warning
}

export class FuturaHealth {
    private alarms = new Map<AlarmDefinition, any>()
    private flags = 0
    private readonly statusFlags: UAVariable
    private readonly deviceHealth: UAVariable
    readonly simulatedFlags: UAVariable

    constructor(private addressSpace: AddressSpace, private device: UAObject) {
        const find = (root: UAObject, ...path: string[]): any => {
            let n: any = root
            for (const p of path) { n = n?.getChildByName(p); if (!n) throw new Error(`health: node ${path.join("/")} not found`) }
            return n
        }
        this.statusFlags = find(device, "StatusFlags")
        this.deviceHealth = find(device, "DeviceHealth")
        const folder = find(device, "DeviceHealthAlarms") as UAObject
        const hasEventSource = addressSpace.findReferenceType(makeNodeId(ReferenceTypeIds.HasEventSource))!
        const conditionClass = addressSpace.findObjectType(makeNodeId(11164))       // MaintenanceConditionClassType

        // the components are the sources of the alarms
        const components = new Map<string, UAObject>()
        for (const name of ["Probe", "Futura", "Spectra"]) {
            const component = find(device, "Components", name) as UAObject
            components.set(name, component)
            device.addReference({ referenceType: hasEventSource, nodeId: component.nodeId })
        }

        // replace the static alarm objects of the type by condition instances that can be activated
        const namespace = folder.namespace as Namespace
        for (const definition of ALARMS) {
            const placeholder = find(folder, definition.name) as UAObject
            const alarmType = placeholder.typeDefinitionObj
            const browseName: QualifiedName = placeholder.browseName
            const description = placeholder.description
            const nodeId = placeholder.nodeId           // the alarm keeps the NodeId of the placeholder
            addressSpace.deleteNode(placeholder.nodeId)
            const alarm = namespace.instantiateDiscreteAlarm(alarmType, {
                nodeId,
                browseName,
                displayName: displayNameFromBrowseName(definition.name),
                description: description?.text ?? undefined,
                componentOf: folder,          // same reference as the declaration in the type: only the DeviceHealthAlarms folder holds the alarms
                conditionClass,
                conditionSource: components.get(definition.component)!,
                conditionName: definition.name,
                inputNode: this.statusFlags,
            } as any)
            // the source of the alarm is the affected component
            const component = components.get(definition.component)!
            alarm.sourceNode?.setValueFromSource({ dataType: DataType.NodeId, value: component.nodeId })
            alarm.sourceName?.setValueFromSource({ dataType: DataType.String, value: component.browseName.name })
            this.alarms.set(definition, alarm)
        }
        this.apply(0, false)

        // writable instance in the Simulator object
        const simulator = find(device, "Simulator") as UAObject
        const rw = AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite
        this.simulatedFlags = simulator.namespace.addVariable({
            browseName: "StatusFlags",
            componentOf: simulator,
            dataType: "UInt16",
            description: { text: "Simulated StatusFlags register. Bits: 0 capacitance, 1 conductivity, 2 temperature out of range, 3 probe leakage, 4 clean leakage, 6 FUTURA memory, 7 probe memory, 9 no probe, 10 signal simulator connected, 12 curve fit error. The alarms and DeviceHealth are derived from it (events on every change)" },
            accessLevel: rw, userAccessLevel: rw,
            value: {
                get: () => new Variant({ dataType: DataType.UInt16, value: this.flags }),
                set: (variant: Variant) => { this.apply(Number(variant.value) & 0xFFFF); return StatusCodes.Good },
            },
        })
    }

    get health(): EnumDeviceHealth { return Number(this.deviceHealth.readValue().value.value) }

    /** sets the register, activates / deactivates the alarms and derives DeviceHealth; each change raises an event */
    apply(flags: number, raiseEvents = true) {
        this.flags = flags & 0xFFFF
        this.statusFlags.setValueFromSource({ dataType: DataType.UInt16, value: this.flags })
        try {
            const simulatorConnected = this.device.getChildByName("Components")?.getChildByName("Futura")?.getChildByName("SignalSimulatorConnected") as UAVariable
            simulatorConnected?.setValueFromSource({ dataType: DataType.Boolean, value: (this.flags & (1 << SIGNAL_SIMULATOR_BIT)) !== 0 })
        } catch { /* optional */ }

        let worst = EnumDeviceHealth.NORMAL
        for (const [definition, alarm] of this.alarms) {
            const active = (this.flags & (1 << definition.bit)) !== 0
            const wasActive = Boolean(alarm.activeState.id.readValue().value.value)
            if (active && !wasActive) {
                alarm.activateAlarm()
                if (raiseEvents) alarm.raiseNewCondition({ message: `Alarm ${definition.description} active`, severity: definition.severity, time: new Date() })
            } else if (!active && wasActive) {
                alarm.deactivateAlarm()
                if (raiseEvents) alarm.raiseNewCondition({ message: `Alarm ${definition.description} inactive`, severity: EventSeverity.Info, time: new Date() })
            }
            if (active && PRIORITY[definition.health]! > PRIORITY[worst]!) worst = definition.health
        }

        if (worst !== this.health) {
            this.deviceHealth.setValueFromSource({ dataType: DataType.Int32, value: worst })
            if (raiseEvents) raiseEvent(this.device, `DeviceHealth changed to ${EnumDeviceHealth[worst]}`, healthSeverity(worst))
        }
    }
}
