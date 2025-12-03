import { CallMethodResultOptions, DataType, LocalizedText, NodeId, ObjectTypeIds, SessionContext, StatusCode, StatusCodes, UAAlarmCondition, UACondition, UAFiniteStateMachine, UAMethod, UAObject, UAObjectType, UAProperty, UAState, UAStateMachineEx, VariantLike } from "node-opcua";
import { UAMaintenanceRequiredAlarm } from "node-opcua-nodeset-di";
import { getLADSNamespace, promoteToFiniteStateMachine } from "./lads-utils";
import { getBooleanValue, setDateTimeValue, setNodeIdValue, setStringValue, setTwoStateVariable } from "./lads-variable-utils";
import { raiseEvent } from "./lads-event-utils";

export interface NameNodeId {
    name: string
    nodeId: NodeId
}

export interface ConditionOptions {
    parent: UAObject
    name: string
    displayName?: string
    optionals?: string[]
}

export interface AlarmConditionOptions extends ConditionOptions{
    inputNode: UAObject
}

export class AlarmConditionImpl {
    options: AlarmConditionOptions
    alarmCondition: UAAlarmCondition
    
    constructor(options: AlarmConditionOptions) {
        this.options = options
        this.alarmCondition = this.objectType.instantiate({
            componentOf: options.parent,
            eventSourceOf: options.parent,
            browseName: options.name,
            displayName: options.displayName ?? options.name,
            optionals: options.optionals
        }) as UAAlarmCondition

        this.postInitialize()
    }

    protected get objectType(): UAObjectType {
        return this.options.parent.addressSpace.findObjectType(ObjectTypeIds.AlarmConditionType)
    }

    protected postInitialize() {
        const options = this.options
        this.alarmCondition.addComment?.bindMethod(this.addComment.bind(this))
        this.alarmCondition.enable?.bindMethod(this.enable.bind(this))
        this.alarmCondition.disable?.bindMethod(this.disable.bind(this))
        this.alarmCondition.acknowledge?.bindMethod(this.acknowledge.bind(this))
        this.alarmCondition.confirm?.bindMethod(this.confirm.bind(this))
    
        this.ackedState = false
        this.confirmedState = false
        this.enabledState = true
        this.activeState = false

        setNodeIdValue(this.alarmCondition.inputNode, options.inputNode.nodeId)
    }

    private async addComment(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions>  { 
        const branchId: NodeId = inputArguments[0].value
        const comment: LocalizedText = inputArguments[1].value
        setStringValue(this.alarmCondition.comment, comment)
        setDateTimeValue(this.alarmCondition.comment.sourceTimestamp, new Date())
        return {statusCode: StatusCodes.Good }
    }

    get ackedState(): boolean { return getBooleanValue(this.alarmCondition.ackedState.id) }
    protected set ackedState(state: boolean) { setTwoStateVariable(this.alarmCondition.ackedState, state, "Acknowledged", "Unacknowledged") }

    private async acknowledge(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions>  { 
        if (this.ackedState) return { statusCode: StatusCodes.BadInvalidState }
        this.ackedState = true
        return { statusCode: StatusCodes.Good }
    }

    get confirmedState(): boolean { return getBooleanValue(this.alarmCondition.confirmedState.id) }
    protected set confirmedState(state: boolean) { setTwoStateVariable(this.alarmCondition.confirmedState, state, "Confirmed", "Unconfirmed") }

    private async confirm(inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions>  { 
        if (this.confirmedState) return { statusCode: StatusCodes.BadInvalidState }
        this.confirmedState = true
        return { statusCode: StatusCodes.Good }
    }

    get enabledState(): boolean { return getBooleanValue(this.alarmCondition.enabledState.id) }
    protected set enabledState(state: boolean) { setTwoStateVariable(this.alarmCondition.enabledState, state, "Enabled", "Disabled") }

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

    get activeState(): boolean { return getBooleanValue(this.alarmCondition.activeState.id) }
    protected set activeState(state: boolean) { setTwoStateVariable(this.alarmCondition.activeState, state, "Active", "Inactive") }

    enterActive(): StatusCode {
        if (!this.enabledState) return StatusCodes.BadStateNotActive
        if (this.activeState) return StatusCodes.BadInvalidState
        this.activeState = true
        return StatusCodes.Good
    }

    enterInactive(): StatusCode  {
        if (!this.enabledState) return StatusCodes.BadStateNotActive
        if (!this.activeState) return StatusCodes.BadInvalidState
        this.activeState = false
        return StatusCodes.Good
    }
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

export interface MaintenanceTaskOptiions extends AlarmConditionOptions {}

export class MaintenanceTaskImpl extends AlarmConditionImpl {
    maintenanceState: UAStateMachineEx
    statePlanned: UAState
    stateExecuting: UAState
    stateFinished: UAState

    constructor(options: MaintenanceTaskOptiions) { super(options) }

    get maintenanceTask(): LADSMaintenanceTask { return this.alarmCondition as LADSMaintenanceTask}

    protected get objectType(): UAObjectType {
        const ns = getLADSNamespace(this.options.parent.addressSpace)
        return ns.findObjectType("MaintenanceTaskType")
    }

    protected postInitialize() {
        super.postInitialize()
        this.maintenanceState = promoteToFiniteStateMachine(this.maintenanceTask.maintenanceState)
        this.maintenanceTask.startTask?.bindMethod(this.startTask.bind(this))
        this.maintenanceTask.stopTask?.bindMethod(this.stopTask.bind(this))
        this.maintenanceTask.resetTask?.bindMethod(this.resetTask.bind(this))
        this.statePlanned = this.maintenanceState.getStateByName(LADSMaintenanceState.Planned)
        this.stateExecuting = this.maintenanceState.getStateByName(LADSMaintenanceState.Executing)
        this.stateFinished = this.maintenanceState.getStateByName(LADSMaintenanceState.Finished)
        this.enterFinished()
    }

    raiseWarningEvent() { raiseEvent(this.maintenanceTask, `Maintenance due warning for ${this.options.inputNode.getDisplayName()}`)}
    raiseAlarmEvent() { raiseEvent(this.maintenanceTask, `Maintenance required for ${this.options.inputNode.getDisplayName()}`) }

    enterActive(): StatusCode {
        if (super.enterActive() !== StatusCodes.Good) return
        this.raiseAlarmEvent()
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