import { contextBridge, ipcRenderer } from 'electron';
import type { Command, RolloutApi, Snapshot } from '../shared/api';

const call = <T>(command: Command, ...args: unknown[]): Promise<T> => ipcRenderer.invoke('rollout', command, ...args);

const api: RolloutApi = {
  getSnapshot: () => call('getSnapshot'),
  install: (app, options) => call('install', app, options),
  startUpdate: (app) => call('startUpdate', app),
  launch: (app, options) => call('launch', app, options),
  stopLaunch: () => call('stopLaunch'),
  scanBluetooth: () => call('scanBluetooth'),
  setSteam: (app, on) => call('setSteam', app, on),
  setAutoUpdate: (on) => call('setAutoUpdate', on),
  setUpdateChannel: (channel) => call('setUpdateChannel', channel),
  checkSelfUpdate: () => call('checkSelfUpdate'),
  downloadSelfUpdate: () => call('downloadSelfUpdate'),
  cancelSelfUpdate: () => call('cancelSelfUpdate'),
  restartForUpdate: () => call('restartForUpdate'),
  startPreviousVersion: () => call('startPreviousVersion'),
  dismissUpdateNotice: () => call('dismissUpdateNotice'),
  uiReady: () => { void call('uiReady'); },
  setLanguage: (code) => call('setLanguage', code),
  setTheme: (theme) => call('setTheme', theme),
  setScale: (scale) => call('setScale', scale),
  setRolloutInSteam: (on, restart) => call('setRolloutInSteam', on, restart),
  remove: (app) => call('remove', app),
  createReport: () => call('createReport'),
  setOverrides: (app, patch) => call('setOverrides', app, patch),
  resetOverrides: () => call('resetOverrides'),
  quit: () => ipcRenderer.send('rollout-quit'),
  onSnapshot: (listener) => {
    ipcRenderer.on('rollout-snapshot', (_event, snapshot: Snapshot) => listener(snapshot));
  }
};

contextBridge.exposeInMainWorld('rollout', api);
