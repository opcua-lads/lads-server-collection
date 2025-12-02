import { CallMethodResultOptions, DataType, NodeId, SessionContext, StatusCode, StatusCodes, UAFiniteStateMachine, UAMethod, UAObject, UAProperty, UAState, UAStateMachineEx, VariantLike } from "node-opcua";
import { UAMaintenanceRequiredAlarm } from "node-opcua-nodeset-di";
import { getLADSNamespace, promoteToFiniteStateMachine } from "./lads-utils";
import { getBooleanValue, setBooleanValue, setNodeIdValue, setTwoStateVariable } from "./lads-variable-utils";
import { raiseEvent } from "./lads-event-utils";

export interface NameNodeId {
    name: string
    nodeId: NodeId
}
export enum LADSMaintenanceState {
    Planned = "Planned",
    Executing = "Executing",
    Finished = "Finished"
}
export interface MaintenanceEventStateMachine extends UAFiniteStateMachine {}

export interface LADSMaintenanceTask extends UAMaintenanceRequiredAlarm {
    maintenanceState: MaintenanceEventStateMachine
    resetTask?: UAMethod
    startTask?: UAMethod
    stopTask?: UAMethod
    partsOfAssetReplaced: UAProperty<NameNodeId[], DataType.ExtensionObject>
    partsOfAssetServiced: UAProperty<NameNodeId[], DataType.ExtensionObject>
}

export class MaintenanceTaskOptions {
    parent: UAObject
    inputNode: UAObject
    name: string
    displayName?: string
    optionals?: string[]
}

export class MaintenanceTaskImpl {
    options: MaintenanceTaskOptions
    maintenanceTask: LADSMaintenanceTask
    maintenanceState: UAStateMachineEx
    statePlanned: UAState
    stateExecuting: UAState
    stateFinished: UAState

    constructor(options: MaintenanceTaskOptions) {
        this.options = options
        const ns = getLADSNamespace(options.parent.addressSpace)
        const maintenanceTaskType = ns.findObjectType("MaintenanceTaskType")
        this.maintenanceTask = maintenanceTaskType.instantiate({
            componentOf: options.parent,
            browseName: options.name,
            displayName: options.displayName ?? options.name,
            optionals: options.optionals
        }) as LADSMaintenanceTask
        setNodeIdValue(this.maintenanceTask.inputNode, options.inputNode.nodeId)

        this.maintenanceState = promoteToFiniteStateMachine(this.maintenanceTask.maintenanceState)
        this.maintenanceTask.startTask?.bindMethod(this.startTask.bind(this))
        this.maintenanceTask.stopTask?.bindMethod(this.stopTask.bind(this))
        this.maintenanceTask.resetTask?.bindMethod(this.resetTask.bind(this))
        this.statePlanned = this.maintenanceState.getStateByName(LADSMaintenanceState.Planned)
        this.stateExecuting = this.maintenanceState.getStateByName(LADSMaintenanceState.Executing)
        this.stateFinished = this.maintenanceState.getStateByName(LADSMaintenanceState.Finished)
        this.enterFinished()

        this.maintenanceTask.enable?.bindMethod(this.enable.bind(this))
        this.maintenanceTask.disable?.bindMethod(this.disable.bind(this))
        this.enabledState = true
        this.activeState = false
    }

    get enabledState(): boolean { return getBooleanValue(this.maintenanceTask.enabledState.id) }
    protected set enabledState(state: boolean) { setTwoStateVariable(this.maintenanceTask.enabledState, state, "Enabled", "Disabled") }
    get activeState(): boolean { return getBooleanValue(this.maintenanceTask.activeState.id) }
    protected set activeState(state: boolean) { setTwoStateVariable(this.maintenanceTask.activeState, state, "Active", "Inactive") }

    private async enable(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions>  { 
        if (this.enabledState) return { statusCode: StatusCodes.BadInvalidState}
        this.enabledState = true
        return { statusCode: StatusCodes.Good }
    }
    private async disable(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> { 
        if (!this.enabledState) return { statusCode: StatusCodes.BadInvalidState}
        this.enabledState = false
        return { statusCode: StatusCodes.Good}
    }

    raiseWarningEvent() { raiseEvent(this.maintenanceTask, `Maintenance due warning for ${this.options.inputNode.getDisplayName()}`)}
    raiseAlarmEvent() { raiseEvent(this.maintenanceTask, `Maintenance required for ${this.options.inputNode.getDisplayName()}`) }

    enterActive(): StatusCode {
        if (!this.enabledState) return StatusCodes.BadStateNotActive
        if (this.activeState) return StatusCodes.BadInvalidState
        this.raiseAlarmEvent()
        this.activeState = true
        return StatusCodes.Good
    }

    enterInactive(): StatusCode  {
        if (!this.enabledState) return StatusCodes.BadStateNotActive
        if (!this.activeState) return StatusCodes.BadInvalidState
        this.activeState = false
        return StatusCodes.Good
    }

    enterPlanned() { this.maintenanceState.setState(this.statePlanned)}
    enterExecuting() { this.maintenanceState.setState(this.stateExecuting)}
    enterFinished() { this.maintenanceState.setState(this.stateFinished)}

    private async startTask(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> { 
        if (this.maintenanceState.currentStateNode === this.stateExecuting) return { statusCode: StatusCodes.BadInvalidState }
        this.enterExecuting()
        return  { statusCode: StatusCodes.Good}
    }

    private async stopTask(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> { 
        if (this.maintenanceState.currentStateNode !== this.stateExecuting) return { statusCode: StatusCodes.BadInvalidState }
        this.enterFinished()
        return  { statusCode: StatusCodes.Good}
    }

    private async resetTask(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> { 
        if (this.maintenanceState.currentStateNode !== this.stateFinished) return { statusCode: StatusCodes.BadInvalidState }
        this.enterPlanned()
        return  { statusCode: StatusCodes.Good}
    }

}