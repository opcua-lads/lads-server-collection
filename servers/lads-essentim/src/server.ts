/**
 * LADS Essentim Server - Mock simulator for essentim IoT sensor devices
 *
 * Simulates Sphere, Spot, and Spider devices with realistic sensor values.
 * Pattern: Single-file server, analog to lads-freezer.
 */

import {
  AddressSpace,
  ApplicationType,
  assert,
  coerceNodeId,
  DataType,
  OPCUAServer,
  RegisterServerMethod,
  UAObject,
  UAObjectType,
  UAStateMachineEx,
  Variant,
} from "node-opcua"
import {
  LADSAnalogScalarSensorFunction,
  LADSDevice,
  LADSFunctionalState,
  LADSFunctionalUnit,
  LADSTwoStateDiscreteSensorFunction,
} from "@interfaces"
import { join } from "path"
import {
  DIObjectIds,
  getChildObjects,
  getStringValue,
  initComponent,
  LADSComponentOptions,
  promoteToFiniteStateMachine,
  setBooleanValue,
  setStringValue,
} from "@utils"

// ═══════════════════════════════════════════════════════════════
// Type definitions matching the Essentim NodeSet
// ═══════════════════════════════════════════════════════════════

interface SphereFunctionSet extends UAObject {
  temperature: LADSAnalogScalarSensorFunction
  pressure: LADSAnalogScalarSensorFunction
  humidity: LADSAnalogScalarSensorFunction
  brightness: LADSAnalogScalarSensorFunction
  motion: LADSTwoStateDiscreteSensorFunction
  extensionSlot6: LADSAnalogScalarSensorFunction
  extensionSlot7: LADSAnalogScalarSensorFunction
  extensionSlot8: LADSAnalogScalarSensorFunction
  extensionSlot9: LADSAnalogScalarSensorFunction
  extensionSlot10: LADSAnalogScalarSensorFunction
}

interface SpotFunctionSet extends UAObject {
  temperature: LADSAnalogScalarSensorFunction
  doorState: LADSTwoStateDiscreteSensorFunction
  motion: LADSTwoStateDiscreteSensorFunction
}

interface SpiderFunctionSet extends UAObject {
  potentialFreeContact: LADSTwoStateDiscreteSensorFunction
  extensionSlot2: LADSAnalogScalarSensorFunction
  extensionSlot3: LADSAnalogScalarSensorFunction
  extensionSlot4: LADSAnalogScalarSensorFunction
  extensionSlot5: LADSAnalogScalarSensorFunction
  extensionSlot6: LADSAnalogScalarSensorFunction
  extensionSlot7: LADSAnalogScalarSensorFunction
  extensionSlot8: LADSAnalogScalarSensorFunction
  extensionSlot9: LADSAnalogScalarSensorFunction
  extensionSlot10: LADSAnalogScalarSensorFunction
}

interface EssentimFunctionalUnit extends Omit<LADSFunctionalUnit, "functionSet"> {
  functionSet: SphereFunctionSet | SpotFunctionSet | SpiderFunctionSet
}

interface EssentimDevice extends Omit<LADSDevice, "functionalUnitSet"> {
  functionalUnitSet: UAObject & { sensorUnit: EssentimFunctionalUnit }
}

// ═══════════════════════════════════════════════════════════════
// Detect capabilities from loaded namespaces
// ═══════════════════════════════════════════════════════════════
function detectCapabilitiesFromNamespaces(addressSpace: AddressSpace): string[] {
  const capabilities: string[] = []
  const namespaceArray = addressSpace.getNamespaceArray()
  for (const ns of namespaceArray) {
    const uri = ns.namespaceUri
    if (uri.startsWith("http://opcfoundation.org/UA/") && uri !== "http://opcfoundation.org/UA/") {
      const parts = uri.replace("http://opcfoundation.org/UA/", "").split("/")
      const capName = parts[0]
      if (capName && capName.length > 0) capabilities.push(capName)
    }
  }
  return [...new Set(capabilities)]
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
function randomWalk(current: number, center: number, step: number, min: number, max: number): number {
  const drift = (center - current) * 0.01 // mean reversion
  const noise = (Math.random() - 0.5) * step
  return Math.max(min, Math.min(max, current + drift + noise))
}

/** Add or update a HasProperty child on an OPC UA node */
function addProperty(node: UAObject, name: string, value: string | number, dataType: DataType = DataType.String): void {
  const existing = node.getPropertyByName(name)
  if (existing) {
    existing.setValueFromSource({ dataType, value })
  } else {
    node.namespace.addVariable({
      propertyOf: node,
      browseName: name,
      dataType,
      value: new Variant({ dataType, value }),
    })
  }
}

// ═══════════════════════════════════════════════════════════════
// Server implementation
// ═══════════════════════════════════════════════════════════════
class EssentimServerImpl {
  server: OPCUAServer
  devices: EssentimDeviceImpl[] = []

  constructor(port: number) {
    const nodeset_path = join(process.cwd(), "nodesets")
    const node_set_filenames = [
      join(nodeset_path, "Opc.Ua.NodeSet2.xml"),
      join(nodeset_path, "Opc.Ua.DI.NodeSet2.xml"),
      join(nodeset_path, "Opc.Ua.Machinery.NodeSet2.xml"),
      join(nodeset_path, "Opc.Ua.AMB.NodeSet2.xml"),
      join(nodeset_path, "Opc.Ua.LADS.NodeSet2.xml"),
      join(nodeset_path, "Essentim.xml"),
    ]

    const uri = "urn:MOCK930003:NodeOPCUA-Server"
    this.server = new OPCUAServer({
      port,
      buildInfo: {
        manufacturerName: "essentim GmbH",
        productName: uri,
        productUri: uri,
        softwareVersion: "1.0.0",
      },
      serverInfo: {
        applicationName: "LADS Essentim",
        applicationType: ApplicationType.Server,
        productUri: uri,
        applicationUri: uri,
      },
      nodeset_filename: node_set_filenames,
      registerServerMethod: RegisterServerMethod.MDNS,
    })
  }

  async start() {
    await this.server.initialize()
    const addressSpace = this.server.engine.addressSpace!

    // Detect and set capabilities for mDNS
    const capabilities = detectCapabilitiesFromNamespaces(addressSpace)
    console.log(`Detected capabilities: ${capabilities.join(", ")}`)
    ;(this.server as any).capabilitiesForMDNS = capabilities

    const nameSpaceDI = addressSpace.getNamespace("http://opcfoundation.org/UA/DI/")
    const nameSpaceEssentim = addressSpace.getNamespace("http://essentim.com/EssentimSensors/")
    assert(nameSpaceEssentim, "Essentim namespace not found")

    const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(DIObjectIds.deviceSet, nameSpaceDI.index))
    assert(deviceSet, "DeviceSet not found")

    // Instantiate devices from types
    const sphereType = nameSpaceEssentim.findObjectType("SphereDeviceType")!
    const spotType = nameSpaceEssentim.findObjectType("SpotDeviceType")!
    const spiderType = nameSpaceEssentim.findObjectType("SpiderDeviceType")!

    // Sphere
    const sphere = <EssentimDevice>sphereType.instantiate({
      componentOf: deviceSet,
      browseName: "SP1BI600050",
    })
    this.devices.push(new SphereDeviceImpl(sphere))

    // Spot
    const spot = <EssentimDevice>spotType.instantiate({
      componentOf: deviceSet,
      browseName: "SO1FW400858",
    })
    this.devices.push(new SpotDeviceImpl(spot))

    // Spider
    const spider = <EssentimDevice>spiderType.instantiate({
      componentOf: deviceSet,
      browseName: "SD3FM203509",
    })
    this.devices.push(new SpiderDeviceImpl(spider))

    await this.server.start()
    const endpoint = this.server.endpoints[0].endpointDescriptions()[0].endpointUrl
    console.log(this.server.buildInfo.productName, "is ready on", endpoint)
    console.log(`Devices: ${this.devices.map((d) => d.name).join(", ")}`)
    console.log("CTRL+C to stop")
  }
}

// ═══════════════════════════════════════════════════════════════
// Base device implementation
// ═══════════════════════════════════════════════════════════════
abstract class EssentimDeviceImpl {
  device: EssentimDevice
  name: string
  functionalUnitStateMachine: UAStateMachineEx

  constructor(device: EssentimDevice, options: LADSComponentOptions) {
    this.device = device
    this.name = options.componentName || "Unknown"
    initComponent(device, options)

    // Set up functional unit state
    const sensorUnit = device.functionalUnitSet.sensorUnit
    this.functionalUnitStateMachine = promoteToFiniteStateMachine(sensorUnit.functionalUnitState)
    this.functionalUnitStateMachine.setState(LADSFunctionalState.Running)

    // Start evaluation loop
    const dT = 500
    setInterval(() => this.evaluate(dT), dT)
  }

  abstract evaluate(dT: number): void
}

// ═══════════════════════════════════════════════════════════════
// Sphere device (Temperature, Pressure, Humidity, Brightness, Motion)
// ═══════════════════════════════════════════════════════════════
class SphereDeviceImpl extends EssentimDeviceImpl {
  fs: SphereFunctionSet
  temp = 21.0
  pressure = 965.0
  humidity = 48.0
  brightness = 15.0
  ext6Temp = 20.8
  ext7Temp = 27.0

  constructor(device: EssentimDevice) {
    super(device, {
      manufacturer: "essentim GmbH",
      model: "sphere",
      serialNumber: "SP1BI600050",
      softwareRevision: "5.1.21-rc6",
      deviceRevision: "1",
      componentName: "SP1BI600050",
      location: "DE/Munich/Schragenhofstr_35/A/Office",
      productCode: "sphere",
      deviceClass: "device/sphere",
    })

    this.fs = device.functionalUnitSet.sensorUnit.functionSet as SphereFunctionSet

    // Enable active sensors
    setBooleanValue(this.fs.temperature.isEnabled, true)
    setBooleanValue(this.fs.pressure.isEnabled, true)
    setBooleanValue(this.fs.humidity.isEnabled, true)
    setBooleanValue(this.fs.brightness.isEnabled, true)
    setBooleanValue(this.fs.motion.isEnabled, true)

    // Extension slots: Slot6 (Pt100, left) and Slot7 (Pt100, right) plugged in
    setBooleanValue(this.fs.extensionSlot6.isEnabled, true)
    addProperty(this.fs.extensionSlot6 as unknown as UAObject, "Port", "left")
    this.ext6Temp = 20.8

    setBooleanValue(this.fs.extensionSlot7.isEnabled, true)
    addProperty(this.fs.extensionSlot7 as unknown as UAObject, "Port", "right")
    this.ext7Temp = 27.0

    // Remaining slots not plugged in
    for (const slot of [this.fs.extensionSlot8, this.fs.extensionSlot9, this.fs.extensionSlot10]) {
      if (slot?.isEnabled) setBooleanValue(slot.isEnabled, false)
    }

    // Set initial values
    this.evaluate(0)
    console.log(`[Sphere] ${this.name} initialized (Slot6=Pt100/left, Slot7=Pt100/right)`)
  }

  evaluate(_dT: number): void {
    this.temp = randomWalk(this.temp, 21.0, 0.2, 15, 30)
    this.pressure = randomWalk(this.pressure, 965.0, 0.5, 950, 980)
    this.humidity = randomWalk(this.humidity, 48.0, 0.3, 30, 70)
    this.brightness = randomWalk(this.brightness, 15.0, 0.5, 0, 100)

    this.fs.temperature.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.temp * 100) / 100 })
    this.fs.pressure.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.pressure * 100) / 100 })
    this.fs.humidity.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.humidity * 10) / 10 })
    this.fs.brightness.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.brightness) })

    // Extension Slot 6 & 7 (Pt100 temperature sensors)
    this.ext6Temp = randomWalk(this.ext6Temp, 20.8, 0.1, 15, 30)
    this.ext7Temp = randomWalk(this.ext7Temp, 27.0, 0.15, 20, 35)
    this.fs.extensionSlot6.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.ext6Temp * 100) / 100 })
    this.fs.extensionSlot7.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.ext7Temp * 100) / 100 })

    // Motion: ~2% chance of toggling per tick
    if (Math.random() < 0.02) {
      const current = this.fs.motion.sensorValue.readValue().value.value
      this.fs.motion.sensorValue.setValueFromSource({ dataType: DataType.Boolean, value: !current })
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Spot device (Temperature, DoorState, Motion)
// ═══════════════════════════════════════════════════════════════
class SpotDeviceImpl extends EssentimDeviceImpl {
  fs: SpotFunctionSet
  temp = 21.0

  constructor(device: EssentimDevice) {
    super(device, {
      manufacturer: "essentim GmbH",
      model: "spot",
      serialNumber: "SO1FW400858",
      softwareRevision: "n/a",
      deviceRevision: "1",
      componentName: "SO1FW400858",
      location: "DE/Munich/Schragenhofstr_35/A/Office",
      productCode: "spot",
      deviceClass: "device/spot",
    })

    this.fs = device.functionalUnitSet.sensorUnit.functionSet as SpotFunctionSet

    setBooleanValue(this.fs.temperature.isEnabled, true)
    setBooleanValue(this.fs.doorState.isEnabled, true)
    setBooleanValue(this.fs.motion.isEnabled, true)

    // Door starts open
    this.fs.doorState.sensorValue.setValueFromSource({ dataType: DataType.Boolean, value: true })

    this.evaluate(0)
    console.log(`[Spot] ${this.name} initialized`)
  }

  evaluate(_dT: number): void {
    this.temp = randomWalk(this.temp, 21.0, 0.15, 15, 30)
    this.fs.temperature.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.temp * 100) / 100 })

    // Door: ~0.5% chance of toggling
    if (Math.random() < 0.005) {
      const current = this.fs.doorState.sensorValue.readValue().value.value
      this.fs.doorState.sensorValue.setValueFromSource({ dataType: DataType.Boolean, value: !current })
    }

    // Motion: ~2% chance of toggling
    if (Math.random() < 0.02) {
      const current = this.fs.motion.sensorValue.readValue().value.value
      this.fs.motion.sensorValue.setValueFromSource({ dataType: DataType.Boolean, value: !current })
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Spider device (PotentialFreeContact, ExtensionSlots)
// ═══════════════════════════════════════════════════════════════
class SpiderDeviceImpl extends EssentimDeviceImpl {
  fs: SpiderFunctionSet
  ext2Value = 0.0

  constructor(device: EssentimDevice) {
    super(device, {
      manufacturer: "essentim GmbH",
      model: "spider-display",
      serialNumber: "SD3FM203509",
      softwareRevision: "1.8.3",
      deviceRevision: "3",
      componentName: "SD3FM203509",
      location: "DE/Munich/Schragenhofstr_35/A/Office",
      productCode: "spider",
      deviceClass: "device/spider-display",
    })

    this.fs = device.functionalUnitSet.sensorUnit.functionSet as SpiderFunctionSet

    setBooleanValue(this.fs.potentialFreeContact.isEnabled, true)

    // ExtensionSlot2 plugged in (second port)
    setBooleanValue(this.fs.extensionSlot2.isEnabled, true)
    addProperty(this.fs.extensionSlot2 as unknown as UAObject, "Port", "second")

    // Remaining slots not plugged in
    for (const slot of [
      this.fs.extensionSlot3, this.fs.extensionSlot4,
      this.fs.extensionSlot5, this.fs.extensionSlot6, this.fs.extensionSlot7,
      this.fs.extensionSlot8, this.fs.extensionSlot9, this.fs.extensionSlot10,
    ]) {
      if (slot?.isEnabled) setBooleanValue(slot.isEnabled, false)
    }

    this.evaluate(0)
    console.log(`[Spider] ${this.name} initialized (Slot2=second)`)
  }

  evaluate(_dT: number): void {
    // PotentialFreeContact: ~1% chance of toggling
    if (Math.random() < 0.01) {
      const current = this.fs.potentialFreeContact.sensorValue.readValue().value.value
      this.fs.potentialFreeContact.sensorValue.setValueFromSource({ dataType: DataType.Boolean, value: !current })
    }

    // ExtensionSlot2: generic analog sensor
    this.ext2Value = randomWalk(this.ext2Value, 0.0, 0.05, -10, 10)
    this.fs.extensionSlot2.sensorValue.setValueFromSource({ dataType: DataType.Double, value: Math.round(this.ext2Value * 100) / 100 })
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
export async function main() {
  const serverImpl = new EssentimServerImpl(parseInt(process.env.PORT || "4845"))
  await serverImpl.start()

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`)
    try {
      await serverImpl.server.shutdown()
      console.log("Server shutdown complete, unregistered from GDS.")
      process.exit(0)
    } catch (err) {
      console.error("Error during shutdown:", err)
      process.exit(1)
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main()
