/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNonEmptyArray } from 'vs/base/common/arrays';
import { Barrier } from 'vs/base/common/async';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import * as perf from 'vs/base/common/performance';
import { isEqualOrParent } from 'vs/base/common/resources';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IExtensionEnablementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { BetterMergeId } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ActivationTimes, ExtensionPointContribution, IExtensionService, IExtensionsStatus, IMessage, IWillActivateEvent, IResponsiveStateChangeEvent, toExtension } from 'vs/workbench/services/extensions/common/extensions';
import { ExtensionMessageCollector, ExtensionPoint, ExtensionsRegistry, IExtensionPoint, IExtensionPointUser } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { ExtensionDescriptionRegistry } from 'vs/workbench/services/extensions/common/extensionDescriptionRegistry';
import { ResponsiveState } from 'vs/workbench/services/extensions/common/rpcProtocol';
import { ExtensionHostProcessManager } from 'vs/workbench/services/extensions/common/extensionHostProcessManager';
import { ExtensionIdentifier, IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { parseExtensionDevOptions } from 'vs/workbench/services/extensions/common/extensionDevOptions';
import { IProductService } from 'vs/platform/product/common/product';

const hasOwnProperty = Object.hasOwnProperty;
const NO_OP_VOID_PROMISE = Promise.resolve<void>(undefined);

export abstract class AbstractExtensionService extends Disposable implements IExtensionService {

	public _serviceBrand: any;

	protected readonly _onDidRegisterExtensions: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidRegisterExtensions = this._onDidRegisterExtensions.event;

	protected readonly _onDidChangeExtensionsStatus: Emitter<ExtensionIdentifier[]> = this._register(new Emitter<ExtensionIdentifier[]>());
	public readonly onDidChangeExtensionsStatus: Event<ExtensionIdentifier[]> = this._onDidChangeExtensionsStatus.event;

	protected readonly _onDidChangeExtensions: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidChangeExtensions: Event<void> = this._onDidChangeExtensions.event;

	protected readonly _onWillActivateByEvent = this._register(new Emitter<IWillActivateEvent>());
	public readonly onWillActivateByEvent: Event<IWillActivateEvent> = this._onWillActivateByEvent.event;

	protected readonly _onDidChangeResponsiveChange = this._register(new Emitter<IResponsiveStateChangeEvent>());
	public readonly onDidChangeResponsiveChange: Event<IResponsiveStateChangeEvent> = this._onDidChangeResponsiveChange.event;

	protected readonly _registry: ExtensionDescriptionRegistry;
	private readonly _installedExtensionsReady: Barrier;
	protected readonly _isDev: boolean;
	private readonly _extensionsMessages: Map<string, IMessage[]>;
	protected readonly _allRequestedActivateEvents: { [activationEvent: string]: boolean; };
	private readonly _proposedApiController: ProposedApiController;
	private readonly _isExtensionDevHost: boolean;
	protected readonly _isExtensionDevTestFromCli: boolean;

	// --- Members used per extension host process
	protected _extensionHostProcessManagers: ExtensionHostProcessManager[];
	protected _extensionHostActiveExtensions: Map<string, ExtensionIdentifier>;
	private _extensionHostProcessActivationTimes: Map<string, ActivationTimes>;
	private _extensionHostExtensionRuntimeErrors: Map<string, Error[]>;

	constructor(
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@INotificationService protected readonly _notificationService: INotificationService,
		@IWorkbenchEnvironmentService protected readonly _environmentService: IWorkbenchEnvironmentService,
		@ITelemetryService protected readonly _telemetryService: ITelemetryService,
		@IExtensionEnablementService protected readonly _extensionEnablementService: IExtensionEnablementService,
		@IFileService protected readonly _fileService: IFileService,
		@IProductService protected readonly _productService: IProductService
	) {
		super();

		// help the file service to activate providers by activating extensions by file system event
		this._register(this._fileService.onWillActivateFileSystemProvider(e => {
			e.join(this.activateByEvent(`onFileSystem:${e.scheme}`));
		}));

		this._registry = new ExtensionDescriptionRegistry([]);
		this._installedExtensionsReady = new Barrier();
		this._isDev = !this._environmentService.isBuilt || this._environmentService.isExtensionDevelopment;
		this._extensionsMessages = new Map<string, IMessage[]>();
		this._allRequestedActivateEvents = Object.create(null);
		this._proposedApiController = new ProposedApiController(this._environmentService, this._productService);

		this._extensionHostProcessManagers = [];
		this._extensionHostActiveExtensions = new Map<string, ExtensionIdentifier>();
		this._extensionHostProcessActivationTimes = new Map<string, ActivationTimes>();
		this._extensionHostExtensionRuntimeErrors = new Map<string, Error[]>();

		const devOpts = parseExtensionDevOptions(this._environmentService);
		this._isExtensionDevHost = devOpts.isExtensionDevHost;
		this._isExtensionDevTestFromCli = devOpts.isExtensionDevTestFromCli;
	}

	protected async _initialize(): Promise<void> {
		perf.mark('willLoadExtensions');
		this._startExtensionHostProcess(true, []);
		this.whenInstalledExtensionsRegistered().then(() => perf.mark('didLoadExtensions'));
		await this._scanAndHandleExtensions();
		this._releaseBarrier();
	}

	private _releaseBarrier(): void {
		perf.mark('extensionHostReady');
		this._installedExtensionsReady.open();
		this._onDidRegisterExtensions.fire(undefined);
		this._onDidChangeExtensionsStatus.fire(this._registry.getAllExtensionDescriptions().map(e => e.identifier));
	}

	private _stopExtensionHostProcess(): void {
		let previouslyActivatedExtensionIds: ExtensionIdentifier[] = [];
		this._extensionHostActiveExtensions.forEach((value) => {
			previouslyActivatedExtensionIds.push(value);
		});

		for (const manager of this._extensionHostProcessManagers) {
			manager.dispose();
		}
		this._extensionHostProcessManagers = [];
		this._extensionHostActiveExtensions = new Map<string, ExtensionIdentifier>();
		this._extensionHostProcessActivationTimes = new Map<string, ActivationTimes>();
		this._extensionHostExtensionRuntimeErrors = new Map<string, Error[]>();

		if (previouslyActivatedExtensionIds.length > 0) {
			this._onDidChangeExtensionsStatus.fire(previouslyActivatedExtensionIds);
		}
	}

	private _startExtensionHostProcess(isInitialStart: boolean, initialActivationEvents: string[]): void {
		this._stopExtensionHostProcess();

		const processManagers = this._createExtensionHosts(isInitialStart, initialActivationEvents);
		processManagers.forEach((processManager) => {
			processManager.onDidExit(([code, signal]) => this._onExtensionHostCrashOrExit(processManager, code, signal));
			processManager.onDidChangeResponsiveState((responsiveState) => { this._onDidChangeResponsiveChange.fire({ isResponsive: responsiveState === ResponsiveState.Responsive }); });
			this._extensionHostProcessManagers.push(processManager);
		});
	}

	private _onExtensionHostCrashOrExit(extensionHost: ExtensionHostProcessManager, code: number, signal: string | null): void {

		// Unexpected termination
		if (!this._isExtensionDevHost) {
			this._onExtensionHostCrashed(extensionHost, code, signal);
			return;
		}

		this._onExtensionHostExit(code);
	}

	protected _onExtensionHostCrashed(extensionHost: ExtensionHostProcessManager, code: number, signal: string | null): void {
		console.error('Extension host terminated unexpectedly. Code: ', code, ' Signal: ', signal);
		this._stopExtensionHostProcess();
	}

	//#region IExtensionService

	public canAddExtension(extension: IExtensionDescription): boolean {
		return false;
	}

	public canRemoveExtension(extension: IExtensionDescription): boolean {
		return false;
	}

	public restartExtensionHost(): void {
		this._stopExtensionHostProcess();
		this._startExtensionHostProcess(false, Object.keys(this._allRequestedActivateEvents));
	}

	public startExtensionHost(): void {
		this._startExtensionHostProcess(false, Object.keys(this._allRequestedActivateEvents));
	}

	public stopExtensionHost(): void {
		this._stopExtensionHostProcess();
	}

	public activateByEvent(activationEvent: string): Promise<void> {
		if (this._installedExtensionsReady.isOpen()) {
			// Extensions have been scanned and interpreted

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			if (!this._registry.containsActivationEvent(activationEvent)) {
				// There is no extension that is interested in this activation event
				return NO_OP_VOID_PROMISE;
			}

			return this._activateByEvent(activationEvent);
		} else {
			// Extensions have not been scanned yet.

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			return this._installedExtensionsReady.wait().then(() => this._activateByEvent(activationEvent));
		}
	}

	private _activateByEvent(activationEvent: string): Promise<void> {
		const result = Promise.all(
			this._extensionHostProcessManagers.map(extHostManager => extHostManager.activateByEvent(activationEvent))
		).then(() => { });
		this._onWillActivateByEvent.fire({
			event: activationEvent,
			activation: result
		});
		return result;
	}

	public whenInstalledExtensionsRegistered(): Promise<boolean> {
		return this._installedExtensionsReady.wait();
	}

	public getExtensions(): Promise<IExtensionDescription[]> {
		return this._installedExtensionsReady.wait().then(() => {
			return this._registry.getAllExtensionDescriptions();
		});
	}

	public getExtension(id: string): Promise<IExtensionDescription | undefined> {
		return this._installedExtensionsReady.wait().then(() => {
			return this._registry.getExtensionDescription(id);
		});
	}

	public readExtensionPointContributions<T>(extPoint: IExtensionPoint<T>): Promise<ExtensionPointContribution<T>[]> {
		return this._installedExtensionsReady.wait().then(() => {
			let availableExtensions = this._registry.getAllExtensionDescriptions();

			let result: ExtensionPointContribution<T>[] = [], resultLen = 0;
			for (let i = 0, len = availableExtensions.length; i < len; i++) {
				let desc = availableExtensions[i];

				if (desc.contributes && hasOwnProperty.call(desc.contributes, extPoint.name)) {
					result[resultLen++] = new ExtensionPointContribution<T>(desc, desc.contributes[extPoint.name]);
				}
			}

			return result;
		});
	}

	public getExtensionsStatus(): { [id: string]: IExtensionsStatus; } {
		let result: { [id: string]: IExtensionsStatus; } = Object.create(null);
		if (this._registry) {
			const extensions = this._registry.getAllExtensionDescriptions();
			for (const extension of extensions) {
				const extensionKey = ExtensionIdentifier.toKey(extension.identifier);
				result[extension.identifier.value] = {
					messages: this._extensionsMessages.get(extensionKey) || [],
					activationTimes: this._extensionHostProcessActivationTimes.get(extensionKey),
					runtimeErrors: this._extensionHostExtensionRuntimeErrors.get(extensionKey) || [],
				};
			}
		}
		return result;
	}

	public getInspectPort(): number {
		return 0;
	}

	//#endregion

	// --- impl

	protected _checkEnableProposedApi(extensions: IExtensionDescription[]): void {
		for (let extension of extensions) {
			this._proposedApiController.updateEnableProposedApi(extension);
		}
	}

	private _isExtensionUnderDevelopment(extension: IExtensionDescription): boolean {
		if (this._environmentService.isExtensionDevelopment) {
			const extDevLocs = this._environmentService.extensionDevelopmentLocationURI;
			if (extDevLocs) {
				const extLocation = extension.extensionLocation;
				for (let p of extDevLocs) {
					if (isEqualOrParent(extLocation, p)) {
						return true;
					}
				}
			}
		}
		return false;
	}

	protected _isEnabled(extension: IExtensionDescription): boolean {
		if (this._isExtensionUnderDevelopment(extension)) {
			// Never disable extensions under development
			return true;
		}

		if (ExtensionIdentifier.equals(extension.identifier, BetterMergeId)) {
			// Check if this is the better merge extension which was migrated to a built-in extension
			return false;
		}

		return this._extensionEnablementService.isEnabled(toExtension(extension));
	}

	protected _doHandleExtensionPoints(affectedExtensions: IExtensionDescription[]): void {
		const affectedExtensionPoints: { [extPointName: string]: boolean; } = Object.create(null);
		for (let extensionDescription of affectedExtensions) {
			if (extensionDescription.contributes) {
				for (let extPointName in extensionDescription.contributes) {
					if (hasOwnProperty.call(extensionDescription.contributes, extPointName)) {
						affectedExtensionPoints[extPointName] = true;
					}
				}
			}
		}

		const messageHandler = (msg: IMessage) => this._handleExtensionPointMessage(msg);
		const availableExtensions = this._registry.getAllExtensionDescriptions();
		const extensionPoints = ExtensionsRegistry.getExtensionPoints();
		for (let i = 0, len = extensionPoints.length; i < len; i++) {
			if (affectedExtensionPoints[extensionPoints[i].name]) {
				AbstractExtensionService._handleExtensionPoint(extensionPoints[i], availableExtensions, messageHandler);
			}
		}
	}

	private _handleExtensionPointMessage(msg: IMessage) {
		const extensionKey = ExtensionIdentifier.toKey(msg.extensionId);

		if (!this._extensionsMessages.has(extensionKey)) {
			this._extensionsMessages.set(extensionKey, []);
		}
		this._extensionsMessages.get(extensionKey)!.push(msg);

		const extension = this._registry.getExtensionDescription(msg.extensionId);
		const strMsg = `[${msg.extensionId.value}]: ${msg.message}`;
		if (extension && extension.isUnderDevelopment) {
			// This message is about the extension currently being developed
			this._showMessageToUser(msg.type, strMsg);
		} else {
			this._logMessageInConsole(msg.type, strMsg);
		}

		if (!this._isDev && msg.extensionId) {
			const { type, extensionId, extensionPointId, message } = msg;
			/* __GDPR__
				"extensionsMessage" : {
					"type" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
					"extensionId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"extensionPointId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"message": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" }
				}
			*/
			this._telemetryService.publicLog('extensionsMessage', {
				type, extensionId: extensionId.value, extensionPointId, message
			});
		}
	}

	private static _handleExtensionPoint<T>(extensionPoint: ExtensionPoint<T>, availableExtensions: IExtensionDescription[], messageHandler: (msg: IMessage) => void): void {
		let users: IExtensionPointUser<T>[] = [], usersLen = 0;
		for (let i = 0, len = availableExtensions.length; i < len; i++) {
			let desc = availableExtensions[i];

			if (desc.contributes && hasOwnProperty.call(desc.contributes, extensionPoint.name)) {
				users[usersLen++] = {
					description: desc,
					value: desc.contributes[extensionPoint.name],
					collector: new ExtensionMessageCollector(messageHandler, desc, extensionPoint.name)
				};
			}
		}

		extensionPoint.acceptUsers(users);
	}

	private _showMessageToUser(severity: Severity, msg: string): void {
		if (severity === Severity.Error || severity === Severity.Warning) {
			this._notificationService.notify({ severity, message: msg });
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	private _logMessageInConsole(severity: Severity, msg: string): void {
		if (severity === Severity.Error) {
			console.error(msg);
		} else if (severity === Severity.Warning) {
			console.warn(msg);
		} else {
			console.log(msg);
		}
	}

	//#region Called by extension host

	public _logOrShowMessage(severity: Severity, msg: string): void {
		if (this._isDev) {
			this._showMessageToUser(severity, msg);
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	public async _activateById(extensionId: ExtensionIdentifier, activationEvent: string): Promise<void> {
		const results = await Promise.all(
			this._extensionHostProcessManagers.map(manager => manager.activate(extensionId, activationEvent))
		);
		const activated = results.some(e => e);
		if (!activated) {
			throw new Error(`Unknown extension ${extensionId.value}`);
		}
	}

	public _onWillActivateExtension(extensionId: ExtensionIdentifier): void {
		this._extensionHostActiveExtensions.set(ExtensionIdentifier.toKey(extensionId), extensionId);
	}

	public _onDidActivateExtension(extensionId: ExtensionIdentifier, startup: boolean, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, activationEvent: string): void {
		this._extensionHostProcessActivationTimes.set(ExtensionIdentifier.toKey(extensionId), new ActivationTimes(startup, codeLoadingTime, activateCallTime, activateResolvedTime, activationEvent));
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	public _onExtensionRuntimeError(extensionId: ExtensionIdentifier, err: Error): void {
		const extensionKey = ExtensionIdentifier.toKey(extensionId);
		if (!this._extensionHostExtensionRuntimeErrors.has(extensionKey)) {
			this._extensionHostExtensionRuntimeErrors.set(extensionKey, []);
		}
		this._extensionHostExtensionRuntimeErrors.get(extensionKey)!.push(err);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	//#endregion

	protected abstract _createExtensionHosts(isInitialStart: boolean, initialActivationEvents: string[]): ExtensionHostProcessManager[];
	protected abstract _scanAndHandleExtensions(): Promise<void>;
	public abstract _onExtensionHostExit(code: number): void;
}

class ProposedApiController {

	private readonly enableProposedApiFor: string | string[];
	private readonly enableProposedApiForAll: boolean;
	private readonly productAllowProposedApi: Set<string>;

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IProductService productService: IProductService
	) {
		this.enableProposedApiFor = environmentService.args['enable-proposed-api'] || [];
		if (this.enableProposedApiFor.length) {
			// Make enabled proposed API be lowercase for case insensitive comparison
			if (Array.isArray(this.enableProposedApiFor)) {
				this.enableProposedApiFor = this.enableProposedApiFor.map(id => id.toLowerCase());
			} else {
				this.enableProposedApiFor = this.enableProposedApiFor.toLowerCase();
			}
		}

		this.enableProposedApiForAll = !environmentService.isBuilt ||
			(!!environmentService.extensionDevelopmentLocationURI && productService.nameLong !== 'Visual Studio Code') ||
			(this.enableProposedApiFor.length === 0 && 'enable-proposed-api' in environmentService.args);

		this.productAllowProposedApi = new Set<string>();
		if (isNonEmptyArray(productService.extensionAllowedProposedApi)) {
			productService.extensionAllowedProposedApi.forEach((id) => this.productAllowProposedApi.add(ExtensionIdentifier.toKey(id)));
		}
	}

	public updateEnableProposedApi(extension: IExtensionDescription): void {
		if (this._allowProposedApiFromProduct(extension.identifier)) {
			// fast lane -> proposed api is available to all extensions
			// that are listed in product.json-files
			extension.enableProposedApi = true;

		} else if (extension.enableProposedApi && !extension.isBuiltin) {
			if (
				!this.enableProposedApiForAll &&
				this.enableProposedApiFor.indexOf(extension.identifier.value.toLowerCase()) < 0
			) {
				extension.enableProposedApi = false;
				console.error(`Extension '${extension.identifier.value} cannot use PROPOSED API (must started out of dev or enabled via --enable-proposed-api)`);

			} else {
				// proposed api is available when developing or when an extension was explicitly
				// spelled out via a command line argument
				console.warn(`Extension '${extension.identifier.value}' uses PROPOSED API which is subject to change and removal without notice.`);
			}
		}
	}

	private _allowProposedApiFromProduct(id: ExtensionIdentifier): boolean {
		return this.productAllowProposedApi.has(ExtensionIdentifier.toKey(id));
	}
}