import { addNotification, dismissNotification } from '../actions/notifications';

import initAboutDialog from '../extensions/about_dialog/index';
import initDownloadManagement from '../extensions/download_management/index';
import initGamemodeManagement from '../extensions/gamemode_management/index';
import initHardlinkActivator from '../extensions/hardlink_activator/index';
import initInstallerFomod from '../extensions/installer_fomod/index';
import initModManagement from '../extensions/mod_management/index';
import initNexusIntegration from '../extensions/nexus_integration/index';
import initNutsLocal from '../extensions/nuts_local/index';
import initProfileManagement from '../extensions/profile_management/index';
import initSettingsInterface from '../extensions/settings_interface/index';
import initSymlinkActivator from '../extensions/symlink_activator/index';
import initSymlinkActivatorElevate from '../extensions/symlink_activator_elevate/index';
import initSettingsUpdate from '../extensions/updater/index';
import initWelcomeScreen from '../extensions/welcome_screen/index';

import { IExtensionInit } from '../types/Extension';
import { IExtensionApi, IExtensionContext, ILookupDetails,
         IOpenOptions, IStateChangeCallback } from '../types/IExtensionContext';
import { INotification } from '../types/INotification';
import { log } from '../util/log';
import { showError } from '../util/message';
import { getSafe } from '../util/storeHelper';

import * as Promise from 'bluebird';
import { app as appIn, dialog as dialogIn, remote } from 'electron';
import * as fs from 'fs';
import { ILookupResult, IModInfo, IReference, ModDB } from 'modmeta-db';
import * as path from 'path';
import { types as ratypes } from 'redux-act';
import ReduxWatcher = require('redux-watcher');

import Module = require('module');

let app = appIn;
let dialog = dialogIn;

if (remote !== undefined) {
  app = remote.app;
  dialog = remote.dialog;
}

// TODO: this inserts the nmm module-path globally so that dynamically loaded
//   extensions can access them. It would be nicer if we could limit this to
//   only the extensions and without using the internal function _initPaths
//   but I didn't find out how (at least not without accessing even more
//   internals)
process.env.NODE_PATH = path.resolve(__dirname, '..', '..', 'node_modules');
Module._initPaths();

interface IRegisteredExtension {
  name: string;
  initFunc: IExtensionInit;
}

type WatcherRegistry = { [watchPath: string]: IStateChangeCallback[] };

/**
 * interface to extensions. This loads extensions and provides the api extensions
 * use
 * 
 * @class ExtensionManager
 */
class ExtensionManager {
  private mExtensions: IRegisteredExtension[];
  private mApi: IExtensionApi;
  private mEventEmitter: NodeJS.EventEmitter;
  private mReduxWatcher: any;
  private mWatches: WatcherRegistry = {};
  private mProtocolHandlers: { [protocol: string]: (url: string) => void } = {};
  private mModDB: ModDB;
  private mPid: number;

  constructor(eventEmitter?: NodeJS.EventEmitter) {
    this.mPid = process.pid;
    this.mEventEmitter = eventEmitter;
    this.mExtensions = this.loadExtensions();
    this.mApi = {
      showErrorNotification: (message: string, details: string | Error) => {
        if (typeof(details) === 'string') {
          dialog.showErrorBox(message, details);
        } else {
          dialog.showErrorBox(message, details.message);
        }
      },
      selectFile: this.selectFile,
      selectExecutable: this.selectExecutable,
      selectDir: this.selectDir,
      events: this.mEventEmitter,
      getPath: this.getPath,
      onStateChange: (path: string[], callback: IStateChangeCallback) => undefined,
      registerProtocol: this.registerProtocol,
      deregisterProtocol: this.deregisterProtocol,
      lookupModReference: this.lookupModReference,
      lookupModMeta: this.lookupModMeta,
      saveModMeta: this.saveModMeta,
    };
  }

  /**
   * sets up the extension manager to work with the specified store
   * 
   * @template S State interface
   * @param {Redux.Store<S>} store
   * 
   * @memberOf ExtensionManager
   */
  public setStore<S>(store: Redux.Store<S>) {
    this.mReduxWatcher = new ReduxWatcher(store);

    this.mApi.sendNotification = (notification: INotification) => {
      store.dispatch(addNotification(notification));
    };
    this.mApi.showErrorNotification = (message: string, details: string | Error) => {
      showError(store.dispatch, message, details);
    };
    this.mApi.dismissNotification = (id: string) => {
      store.dispatch(dismissNotification(id));
    };
    this.mApi.store = store;
    this.mApi.onStateChange = (watchPath: string[], callback: IStateChangeCallback) => {
      let lastValue;
      let key = watchPath.join('.');
      if (this.mWatches[key] === undefined) {
        this.mWatches[key] = [];
        this.mReduxWatcher.watch(watchPath,
          // tslint:disable-next-line: no-unused-variable
          ({ cbStore, selector, prevState, currentState, prevValue, currentValue }) => {
            // TODO redux-watch seems to trigger even if the value has not changed. This can
            //   lead to an endless loop where a state change handler re-sets the same value
            //   causing an infinite loop
            if (currentValue === lastValue) {
              return;
            }
            lastValue = currentValue;
            for (let cb of this.mWatches[key]) {
              try {
                cb(prevValue, currentValue);
              } catch (err) {
                log('error', 'state change handler failed', {
                  message: err.message,
                  stack: err.stack,
                });
              }
            }
          });
      }
      this.mWatches[key].push(callback);
    };

    // TODO the mod db doesn't depend on the store but it must only be instantiated
    // in one process and this is a cheap way of achieving that
    this.mModDB = new ModDB(
        app.getPath('userData'),
        getSafe(store.getState(), ['settings', 'gameMode', 'current'],
                undefined),
        getSafe(store.getState(), ['account', 'nexus', 'APIKey'], ''));
  }

  /**
   * gain acces to the extension api
   * 
   * @returns
   * 
   * @memberOf ExtensionManager
   */
  public getApi() {
    return this.mApi;
  }

  /**
   * retrieve list of all reducers registered by extensions
   */
  public getReducers() {
    let reducers = [];

    let context = this.emptyExtensionContext();

    context.registerReducer = (path: string[], reducer: any) => {
      reducers.push({ path, reducer });
    };

    this.mExtensions.forEach((ext) => ext.initFunc(context));

    return reducers;
  }

  /**
   * apply all extensions that were registered by extensions
   * 
   * @memberOf ExtensionManager
   */
  public applyExtensionsOfExtensions() {
    let extFunctions: { name: string, registerFunc: Function }[] = [];
    this.apply('registerExtensionFunction', (name: string, registerFunc: () => void) => {
      extFunctions.push({ name, registerFunc });
    });

    if (extFunctions.length > 0) {
      let context = this.emptyExtensionContext();
      for (let func of extFunctions) {
        context[func.name] = func.registerFunc;
      }
      this.mExtensions.forEach((ext) => ext.initFunc(context));
    }
  }

  /**
   * runs the extension init function with the specified register-function
   * set
   * 
   * @param {string} funcName
   * @param {Function} func
   * 
   * @memberOf ExtensionManager
   */
  public apply(funcName: string, func: Function) {
    let context = this.emptyExtensionContext();

    context[funcName] = func;
    this.mExtensions.forEach((ext) => ext.initFunc(context));
  }

  /**
   * call the "once" function for all extensions. This should really only be called
   * once.
   */
  public doOnce() {
    let context = this.emptyExtensionContext();

    context.once = (callback: () => void) => {
      callback();
    };

    this.mExtensions.forEach((ext: IRegisteredExtension) => {
      try {
        ext.initFunc(context);
      } catch (err) {
        log('warn', 'failed to call once',
            { err: err.message, stack: err.stack, extension: ext.name });
      }
    });
  }

  public getProtocolHandler(protocol: string) {
    return this.mProtocolHandlers[protocol] || null;
  }

  private getPath(name: Electron.AppPathName) {
    return app.getPath(name);
  }

  private selectFile(options: IOpenOptions) {
    return new Promise<string>((resolve, reject) => {
      const fullOptions = Object.assign({}, options, {
        properties: ['openFile'],
      });
      dialog.showOpenDialog(null, fullOptions, (fileNames: string[]) => {
        if ((fileNames !== undefined) && (fileNames.length > 0)) {
          resolve(fileNames[0]);
        } else {
          resolve(undefined);
        }
      });
    });
  }

  private selectExecutable(options: IOpenOptions) {
    return new Promise<string>((resolve, reject) => {
      const fullOptions = Object.assign({}, options, {
        properties: ['openFile'],
        filters: [
          { name: 'All Executables', extensions: ['exe', 'cmd', 'bat', 'jar', 'py'] },
          { name: 'Native', extensions: ['exe', 'cmd', 'bat'] },
          { name: 'Java', extensions: ['jar'] },
          { name: 'Python', extensions: ['py'] },
        ],
      });
      dialog.showOpenDialog(null, fullOptions, (fileNames: string[]) => {
        if ((fileNames !== undefined) && (fileNames.length > 0)) {
          resolve(fileNames[0]);
        } else {
          resolve(undefined);
        }
      });
    });
  }

  private selectDir(options: IOpenOptions) {
    return new Promise<string>((resolve, reject) => {
      const fullOptions = Object.assign({}, options, {
        properties: ['openDirectory'],
      });
      dialog.showOpenDialog(null, fullOptions, (fileNames: string[]) => {
        if ((fileNames !== undefined) && (fileNames.length > 0)) {
          resolve(fileNames[0]);
        } else {
          resolve(undefined);
        }
      });
    });
  }

  private registerProtocol = (protocol: string, callback: (url: string) => void) => {
    log('info', 'register protocol', { protocol });
    if (process.execPath.endsWith('electron.exe')) {
      // make it work when using the development version
      app.setAsDefaultProtocolClient(protocol, process.execPath,
                                     [ path.resolve(__dirname, '..', '..') ]);
    } else {
      app.setAsDefaultProtocolClient(protocol);
    }
    this.mProtocolHandlers[protocol] = callback;
  }

  private deregisterProtocol(protocol: string) {
    log('info', 'deregister protocol');
    if (process.execPath.endsWith('electron.exe')) {
      // make it work when using the development version
      app.removeAsDefaultProtocolClient(protocol, process.execPath,
                                        [ path.resolve(__dirname, '..', '..') ]);
    } else {
      app.removeAsDefaultProtocolClient(protocol);
    }
  }

  private lookupModReference = (reference: IReference): Promise<ILookupResult[]> => {
    if (this.mModDB !== undefined) {
      // TODO support other reference type
      return this.mModDB.getByKey(reference.fileMD5);
    } else {
      return Promise.reject({ message: 'wrong process' });
    }
  }

  private lookupModMeta = (filePath: string, detail: ILookupDetails): Promise<ILookupResult[]> => {
    if (this.mModDB !== undefined) {
      return this.mModDB.lookup(filePath, detail.gameId, detail.modId);
    } else {
      return Promise.reject(new Error('wrong process'));
    }
  }

  private saveModMeta = (modInfo: IModInfo): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      this.mModDB.insert(modInfo);
      resolve();
    });
  }

  private emptyExtensionContext(): IExtensionContext {
    return {
      registerMainPage: () => undefined,
      registerSettings: () => undefined,
      registerIcon: () => undefined,
      registerFooter: () => undefined,
      registerReducer: () => undefined,
      registerExtensionFunction: () => undefined,
      registerStyle: () => undefined,
      registerPersistor: () => undefined,
      registerSettingsHive: () => undefined,
      once: () => undefined,
      api: Object.assign({}, this.mApi),
    };
  }

  private loadDynamicExtension(extensionPath: string): IRegisteredExtension {
    let indexPath = path.join(extensionPath, 'index.js');
    log('info', 'load dynamic extension', indexPath);
    if (fs.existsSync(indexPath)) {
      // TODO: workaround. redux-act stores a global set of action creator ids and throws if
      //  there would be a duplicate. Since extensions might import actions we already have loaded
      //  here, that mechanism would fail. 
      ratypes.clear();

      return { name: path.basename(extensionPath), initFunc: require(indexPath).default };
    } else {
      return undefined;
    }
  }

  private loadDynamicExtensions(extensionsPath: string): IRegisteredExtension[] {
    if (!fs.existsSync(extensionsPath)) {
      log('info', 'failed to load dynamic extensions, path doesn\'t exist', extensionsPath);
      fs.mkdirSync(extensionsPath);
      return [];
    }

    let res = fs.readdirSync(extensionsPath)
      .filter((name) => fs.statSync(path.join(extensionsPath, name)).isDirectory())
      .map((name) => {
        try {
          return this.loadDynamicExtension(path.join(extensionsPath, name));
        } catch (err) {
          log('warn', 'failed to load dynamic extension', { error: err.message });
          return undefined;
        }
      });
    return res.filter((reg: IRegisteredExtension) => reg !== undefined);
  }

  /**
   * retrieves all extensions to the base functionality, both the static
   * and external ones.
   * This loads external extensions from disc synchronously
   * 
   * @returns {IExtensionInit[]}
   */
  private loadExtensions(): IRegisteredExtension[] {
    const bundledPath = path.resolve(__dirname, '..', 'bundledPlugins');
    log('info', 'bundle at', bundledPath);
    const extensionsPath = path.join(app.getPath('userData'), 'plugins');
    return [
      { name: 'settings_interface', initFunc: initSettingsInterface },
      { name: 'settings_update', initFunc: initSettingsUpdate },
      { name: 'about_dialog', initFunc: initAboutDialog },
      { name: 'welcome_screen', initFunc: initWelcomeScreen },
      { name: 'mod_management', initFunc: initModManagement },
      { name: 'profile_management', initFunc: initProfileManagement },
      { name: 'nexus_integration', initFunc: initNexusIntegration },
      { name: 'download_management', initFunc: initDownloadManagement },
      { name: 'gamemode_management', initFunc: initGamemodeManagement },
      { name: 'nuts_local', initFunc: initNutsLocal },
      { name: 'symlink_activator', initFunc: initSymlinkActivator },
      { name: 'symlink_activator_elevate', initFunc: initSymlinkActivatorElevate },
      { name: 'hardlink_activator', initFunc: initHardlinkActivator },
      { name: 'installer_fomod', initFunc: initInstallerFomod },
    ]
    .concat(this.loadDynamicExtensions(bundledPath))
    .concat(this.loadDynamicExtensions(extensionsPath));
  }

}

export default ExtensionManager;
