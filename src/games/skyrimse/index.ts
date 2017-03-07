import { IGame } from '../../types/IGame';
import { ITool } from '../../types/ITool';

import { app as appIn, remote } from 'electron';
import * as path from 'path';

import * as Promise from 'bluebird';
import Registry = require('winreg');

const app = appIn || remote.app;

function findGame() {
  if (Registry === undefined) {
    // linux ? macos ?
    return null;
  }

  let regKey = new Registry({
    hive: Registry.HKLM,
    key: '\\Software\\Wow6432Node\\Bethesda Softworks\\Skyrim Special Edition',
  });

  return new Promise<string>((resolve, reject) => {
    regKey.get('Installed Path', (err: Error, result: Registry.RegistryItem) => {
      if (err !== null) {
        reject(new Error(err.message));
      } else {
        resolve(result.value);
      }
    });
  });
}

function getIniPath() {
  return path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition', 'Skyrim.ini');
}

let tools: ITool[] = [
  {
    id: 'SSEEdit',
    name: 'SSEEdit',
    logo: 'tes5edit.png',
    executable: () => 'sseedit.exe',
    requiredFiles: [
      'tes5edit.exe',
    ],
  },
  {
    id: 'WryeBash',
    name: 'WryeBash',
    logo: 'wrye.png',
    executable: () => 'wryebash.exe',
    requiredFiles: [
      'wryebash.exe',
    ],
  },
  {
    id: 'loot',
    name: 'LOOT',
    logo: 'loot.png',
    executable: () => 'loot.exe',
    parameters: [
      '--game=skyrimse',
    ],
    requiredFiles: [
      'loot.exe',
    ],
  },
  {
    id: 'FNIS',
    name: 'FNIS',
    logo: 'fnis.png',
    executable: () => 'GenerateFNISForUsers.exe',
    requiredFiles: [
      'GenerateFNISForUsers.exe',
    ],
  },
];

const game: IGame = {
  id: 'skyrimse',
  name: 'Skyrim Special Edition',
  mergeMods: true,
  queryPath: findGame,
  iniFilePath: getIniPath,
  supportedTools: tools,
  queryModPath: () => './data',
  logo: 'logo.png',
  executable: () => 'SkyrimSE.exe',
  requiredFiles: [
    'SkyrimSE.exe',
  ],
};

export default game;
