/*import { assert, DataType, INamespace, LocalizedText, UAFiniteStateMachine, UAObject, UAProperty, UAStateMachineEx } from "node-opcua";
import { LADSDevice, LADSDeviceStateMachine, LADSFunctionalUnit, LADSFunctionalUnitSet, LADSFunctionalUnitStateMachine, LADSFunctionSet, LADSProgramManager, MachineryOperationModeStateMachine } from "./lads-interfaces";
import { UAObjectImpl} from "node_modules/node-opcua-address-space/src/ua_object_impl"
import { promoteToFiniteStateMachine } from "./lads-utils";

export class LADSDeviceImpl extends UAObjectImpl implements LADSDevice {
    deviceState: LADSDeviceStateMachine;
    machineryItemState?: UAFiniteStateMachine;
    machineryOperationMode?: MachineryOperationModeStateMachine;
    functionalUnitSet: UAObject | LADSFunctionalUnitSet;
    manufacturer: UAProperty<LocalizedText, DataType.LocalizedText>;
    model: UAProperty<LocalizedText, DataType.LocalizedText>;
    hardwareRevision: UAProperty<string, DataType.String>;
    softwareRevision: UAProperty<string, DataType.String>;
    deviceRevision: UAProperty<string, DataType.String>;
    deviceManual: UAProperty<string, DataType.String>;
    serialNumber: UAProperty<string, DataType.String>;
    revisionCounter: UAProperty<number, DataType.Int32>;  

    nameSpaceLADS: INamespace
    deviceStateImpl: UAStateMachineEx
    machineryItemStateImpl?: UAStateMachineEx;
    machineryOperationModeImpl?: UAStateMachineEx;

    public _post_initialize(): void {
        this.nameSpaceLADS = this.addressSpace.getNamespace('http://opcfoundation.org/UA/LADS/')
        this.deviceStateImpl = promoteToFiniteStateMachine(this.deviceState)
        this.machineryItemState?this.machineryItemStateImpl = promoteToFiniteStateMachine(this.machineryItemState):0
        this.machineryOperationMode?this.machineryOperationModeImpl = promoteToFiniteStateMachine(this.machineryOperationMode):0
    }

    getFunctionalUnits(): LADSFunctionalUnit[] {
        const functionalUnitType = this.nameSpaceLADS.findObjectType('FunctionalUnitType')
        const fus = this.functionalUnitSet as UAObject
        const result: LADSFunctionalUnit[] = []
        fus.getComponents().forEach(node => {
            if ((node as UAObject).typeDefinitionObj.isSubtypeOf(functionalUnitType)) {
                result.push(node as LADSFunctionalUnit)
            }
        })
        return result
    }

    getFunctionalUnitsImpl(): LADSFunctionalUnitImpl[] {return this.getFunctionalUnits().map(functionalUnit => promoteToLADSFunctionalUnit(functionalUnit))}

}

export function promoteToLADSDevice(node: LADSDevice): LADSDeviceImpl {
    if (node instanceof LADSDeviceImpl) {
        return node;
    }
    Object.setPrototypeOf(node, LADSDeviceImpl.prototype)
    assert(node instanceof LADSDeviceImpl, "should now be a LADS Device");
    const _node = node as unknown as LADSDeviceImpl
    _node._post_initialize();
    return _node
}

export class LADSFunctionalUnitImpl extends UAObjectImpl implements LADSFunctionalUnit {
    functionalUnitState: LADSFunctionalUnitStateMachine;
    functionSet: UAObject | LADSFunctionSet;
    programManager: LADSProgramManager;
    functionalUnitStateImpl: UAStateMachineEx

    public _post_initialize(): void {
        this.functionalUnitStateImpl = promoteToFiniteStateMachine(this.functionalUnitState)
    }
}

export function promoteToLADSFunctionalUnit(node: LADSFunctionalUnit): LADSFunctionalUnitImpl {
    if (node instanceof LADSFunctionalUnitImpl) {
        return node;
    }
    Object.setPrototypeOf(node, LADSFunctionalUnitImpl.prototype)
    assert(node instanceof LADSFunctionalUnitImpl, "should now be a LADS FunctionalUnit");
    const _node = node as unknown as LADSFunctionalUnitImpl
    _node._post_initialize();
    return _node
}
*/
