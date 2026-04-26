// jupyterlab-codex — JupyterLab 4.x frontend entry point.
//
// Registers a left-sidebar widget that hosts an OpenAI Codex chat panel,
// plus a command (and palette entry) to focus that sidebar.

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { CodexSidebarWidget, ICodexSettings } from './widget';

const PLUGIN_ID = 'jupyterlab-codex:plugin';
const CMD_OPEN = 'jupyterlab-codex:open-sidebar';

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette, ILayoutRestorer, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null,
    settingRegistry: ISettingRegistry | null
  ) => {
    console.log('jupyterlab-codex: activating');

    const sidebar = new CodexSidebarWidget(
      notebookTracker,
      app.serviceManager.contents
    );
    app.shell.add(sidebar, 'left', { rank: 900 });
    if (restorer) {
      restorer.add(sidebar, 'jupyterlab-codex-sidebar');
    }

    if (settingRegistry) {
      const applySettings = (s: ISettingRegistry.ISettings) => {
        const composite = s.composite as unknown as Partial<ICodexSettings>;
        sidebar.setSettings(composite ?? {});
      };
      settingRegistry
        .load(PLUGIN_ID)
        .then(s => {
          applySettings(s);
          s.changed.connect(applySettings);
        })
        .catch(err => {
          console.warn('jupyterlab-codex: failed to load settings', err);
        });
    }

    app.commands.addCommand(CMD_OPEN, {
      label: 'Codex: Open chat sidebar',
      execute: () => {
        app.shell.activateById(sidebar.id);
      }
    });

    if (palette) {
      palette.addItem({ command: CMD_OPEN, category: 'Codex' });
    }
  }
};

export default plugin;
