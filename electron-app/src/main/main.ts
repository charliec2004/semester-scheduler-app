/**
 * Electron Main Process
 * Handles window lifecycle, IPC, Python solver spawning, and file system access.
 * All operations run fully locally - no network required.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import type {
  SolverRunConfig,
  SolverProgress,
  AppSettings,
  FlagPreset,
  HistoryEntry,
  ConfigSnapshot,
  StaffMember,
  Department,
} from './ipc-types';
import { DEFAULT_SETTINGS, normalizeAppSettings } from './ipc-types';
import {
  initUpdater,
  checkForUpdates,
  downloadAndInstallUpdate,
  quitAndInstall,
  getUpdateStatus,
} from './updater';

const MAX_HISTORY_ENTRIES = 5;

// Handle EPIPE errors gracefully (occurs when pipe is closed, e.g., window closes during solver)
process.stdout?.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return;
});
process.stderr?.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return;
});
// Catch uncaught EPIPE exceptions from console.log when pipe is broken
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return; // Silently ignore broken pipe
  // Log and exit for other errors (can't re-throw in uncaughtException handler)
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// Initialize persistent settings store
const store = new Store<{
  settings: AppSettings;
  presets: FlagPreset[];
  recentFiles: { staff?: string; dept?: string };
  history: HistoryEntry[];
  savedStaff: StaffMember[];
  savedDepartments: Department[];
}>({
  defaults: {
    settings: DEFAULT_SETTINGS,
    presets: [],
    recentFiles: {},
    history: [],
    savedStaff: [],
    savedDepartments: [],
  },
});

let mainWindow: BrowserWindow | null = null;
let activeSolverProcess: ChildProcess | null = null;
let currentRunId: string | null = null;
let solverStartTime: number = 0;
let solverMaxTime: number = 180;

// Get the project root (parent of electron-app)
function getProjectRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  // In dev: __dirname is dist/main/main, so go up 4 levels to project root
  return path.join(__dirname, '..', '..', '..', '..');
}

// Get the history storage directory
function getHistoryDir(): string {
  const dir = path.join(app.getPath('userData'), 'history');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Resolve paths for development vs production
function getResourcePath(relativePath: string): string {
  if (app.isPackaged) {
    // In packaged mode, Python files are in the 'python' subdirectory
    if (relativePath === 'main.py' || relativePath.startsWith('scheduler')) {
      return path.join(process.resourcesPath, 'python', relativePath);
    }
    // Sample files are in the 'samples' subdirectory
    if (relativePath === 'employees.csv' || relativePath === 'requirements.csv') {
      return path.join(process.resourcesPath, 'samples', relativePath);
    }
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(getProjectRoot(), relativePath);
}

function getPythonPath(): string {
  if (app.isPackaged) {
    const platform = process.platform;
    // Check for bundled Python first
    let bundledPython: string;
    if (platform === 'win32') {
      bundledPython = path.join(process.resourcesPath, 'python', 'python.exe');
    } else {
      bundledPython = path.join(process.resourcesPath, 'python', 'bin', 'python3');
    }
    // If bundled Python exists, use it; otherwise fall back to system Python
    if (fs.existsSync(bundledPython)) {
      return bundledPython;
    }
    // Fall back to system Python
    console.log('Bundled Python not found, using system Python');
    return platform === 'win32' ? 'python' : 'python3';
  }
  const projectRoot = getProjectRoot();
  const venvPython = path.join(projectRoot, 'venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}

// Check if Python is available and has required packages
async function checkPythonAvailability(): Promise<{ available: boolean; error?: string }> {
  const pythonPath = getPythonPath();
  
  return new Promise((resolve) => {
    // First check if Python exists
    const checkProcess = spawn(pythonPath, ['--version'], {
      env: { ...process.env },
    });
    
    // Consume stdout/stderr to prevent buffer overflow
    checkProcess.stdout?.on('data', () => {});
    checkProcess.stderr?.on('data', () => {});
    
    checkProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        const platform = process.platform;
        let installInstructions: string;
        
        if (platform === 'win32') {
          installInstructions = 'Please install Python 3.12+ from https://python.org and ensure it is added to your PATH during installation.';
        } else if (platform === 'darwin') {
          installInstructions = 'Please install Python 3.12+ using: brew install python3\nOr download from https://python.org';
        } else {
          installInstructions = 'Please install Python 3.12+ using your package manager (e.g., apt install python3) or from https://python.org';
        }
        
        resolve({
          available: false,
          error: `Python is not installed or not found in PATH.\n\n${installInstructions}`,
        });
      } else {
        resolve({
          available: false,
          error: `Failed to start Python: ${err.message}`,
        });
      }
    });
    
    checkProcess.on('close', (code: number | null) => {
      if (code === 0) {
        // Python exists, now check for required packages
        const checkPackages = spawn(pythonPath, ['-c', 'import ortools; import pandas; import openpyxl; import xlsxwriter'], {
          env: { ...process.env },
        });
        
        // Consume stderr to prevent buffer overflow
        checkPackages.stderr?.on('data', () => {});
        
        checkPackages.on('close', (pkgCode: number | null) => {
          if (pkgCode === 0) {
            resolve({ available: true });
          } else {
            resolve({
              available: false,
              error: `Python is installed but missing required packages.\n\nPlease run:\n${pythonPath === 'python' || pythonPath === 'python3' ? 'pip' : pythonPath.replace('python', 'pip')} install ortools pandas openpyxl xlsxwriter\n\nOr: pip install -r requirements.txt`,
            });
          }
        });
        
        checkPackages.on('error', () => {
          resolve({ available: true }); // Assume OK if we can't check
        });
      } else {
        resolve({
          available: false,
          error: `Python check failed with exit code ${code}`,
        });
      }
    });
  });
}

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';
  
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Semester Scheduler',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  // macOS: hidden title bar with traffic lights
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 18 };
  }
  
  // Windows/Linux: use titleBarOverlay for native window controls
  if (isWin || isLinux) {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.titleBarOverlay = {
      color: '#0f172a',
      symbolColor: '#94a3b8',
      height: 48,
    };
  }

  mainWindow = new BrowserWindow(windowOptions);

  // Load the renderer
  const rendererDevUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (rendererDevUrl) {
    mainWindow.loadURL(rendererDevUrl);
    // DevTools can be opened manually with Cmd+Option+I (Mac) or Ctrl+Shift+I (Windows/Linux)
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (activeSolverProcess) {
      activeSolverProcess.kill();
      activeSolverProcess = null;
    }
  });
}

app.whenReady().then(() => {
  // Set app name for dock/taskbar (especially needed in dev mode)
  app.setName('Scheduler');
  
  createWindow();
  registerIpcHandlers();
  cleanupOldHistory();
  createApplicationMenu();

  // Initialize auto-updater after window is ready
  if (mainWindow) {
    initUpdater(mainWindow);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up old history entries beyond MAX_HISTORY_ENTRIES
function cleanupOldHistory(): void {
  const history = store.get('history');
  if (history.length > MAX_HISTORY_ENTRIES) {
    const toRemove = history.slice(MAX_HISTORY_ENTRIES);
    for (const entry of toRemove) {
      deleteHistoryFiles(entry.id);
    }
    store.set('history', history.slice(0, MAX_HISTORY_ENTRIES));
  }
}

// Delete files associated with a history entry
function deleteHistoryFiles(historyId: string): void {
  const historyDir = getHistoryDir();
  const entryDir = path.join(historyDir, historyId);
  if (fs.existsSync(entryDir)) {
    fs.rmSync(entryDir, { recursive: true, force: true });
  }
}

// Save a new history entry
function saveHistoryEntry(entry: HistoryEntry, config: ConfigSnapshot): void {
  const historyDir = getHistoryDir();
  const entryDir = path.join(historyDir, entry.id);
  fs.mkdirSync(entryDir, { recursive: true });
  
  // Save config snapshot
  fs.writeFileSync(
    path.join(entryDir, 'config.json'),
    JSON.stringify(config, null, 2)
  );
  
  // Add to history
  const history = store.get('history');
  history.unshift(entry);
  
  // Keep only last MAX_HISTORY_ENTRIES
  if (history.length > MAX_HISTORY_ENTRIES) {
    const toRemove = history.slice(MAX_HISTORY_ENTRIES);
    for (const old of toRemove) {
      deleteHistoryFiles(old.id);
    }
    store.set('history', history.slice(0, MAX_HISTORY_ENTRIES));
  } else {
    store.set('history', history);
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  // File operations
  ipcMain.handle('files:openCsv', async (_event, kind: 'staff' | 'dept') => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'staff' ? 'Select Staff CSV' : 'Select Department CSV',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    store.set(`recentFiles.${kind}`, filePath);
    return { path: filePath, content, canceled: false };
  });

  ipcMain.handle('files:saveCsvToTemp', async (_event, { content, filename }: { content: string; filename: string }) => {
    const tempDir = path.join(app.getPath('temp'), 'scheduler-temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    return { path: filePath };
  });

  ipcMain.handle('files:saveCsv', async (_event, { kind, content }: { kind: 'staff' | 'dept'; content: string }) => {
    const defaultName = kind === 'staff' ? 'employees.csv' : 'departments.csv';
    
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: `Save ${kind === 'staff' ? 'Staff' : 'Department'} CSV`,
      defaultPath: defaultName,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { path: result.filePath, canceled: false };
  });

  ipcMain.handle('files:downloadSample', async (_event, kind: 'staff' | 'dept') => {
    const sampleName = kind === 'staff' ? 'employees.csv' : 'requirements.csv';
    const samplePath = getResourcePath(sampleName);

    const result = await dialog.showSaveDialog(mainWindow!, {
      title: `Save Sample ${kind === 'staff' ? 'Staff' : 'Department'} CSV`,
      defaultPath: sampleName,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    fs.copyFileSync(samplePath, result.filePath);
    return { path: result.filePath, canceled: false };
  });

  ipcMain.handle('files:readFile', async (_event, filePath: string) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { content, error: null };
    } catch (err) {
      return { content: null, error: (err as Error).message };
    }
  });

  // Save output file with user-chosen location
  ipcMain.handle('files:saveOutputAs', async (_event, { sourcePath, defaultName }: { sourcePath: string; defaultName: string }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save Schedule',
      defaultPath: defaultName,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    fs.copyFileSync(sourcePath, result.filePath);
    return { path: result.filePath, canceled: false };
  });

  ipcMain.handle('files:openInExplorer', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // Settings
  ipcMain.handle('settings:load', () => {
    const stored = store.get('settings') as Partial<AppSettings>;
    const normalized = normalizeAppSettings(stored);
    store.set('settings', normalized);
    return normalized;
  });

  ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
    store.set('settings', normalizeAppSettings(settings));
    return { success: true };
  });

  ipcMain.handle('settings:reset', () => {
    store.reset('settings');
    return store.get('settings');
  });

  // Staff & Department Data Persistence
  ipcMain.handle('data:loadStaff', () => {
    return store.get('savedStaff');
  });

  ipcMain.handle('data:saveStaff', (_event, staff: StaffMember[]) => {
    store.set('savedStaff', staff);
    return { success: true };
  });

  ipcMain.handle('data:loadDepartments', () => {
    return store.get('savedDepartments');
  });

  ipcMain.handle('data:saveDepartments', (_event, departments: Department[]) => {
    store.set('savedDepartments', departments);
    return { success: true };
  });

  ipcMain.handle('data:clearAll', () => {
    store.set('savedStaff', []);
    store.set('savedDepartments', []);
    store.set('presets', []);
    store.set('recentFiles', {});
    return { success: true };
  });

  // Presets
  ipcMain.handle('presets:list', () => {
    return store.get('presets');
  });

  ipcMain.handle('presets:save', (_event, preset: FlagPreset) => {
    const presets = store.get('presets');
    const existingIndex = presets.findIndex((p: FlagPreset) => p.id === preset.id);
    if (existingIndex >= 0) {
      presets[existingIndex] = preset;
    } else {
      presets.push({ ...preset, id: preset.id || uuidv4() });
    }
    store.set('presets', presets);
    return { success: true };
  });

  ipcMain.handle('presets:delete', (_event, presetId: string) => {
    const presets = store.get('presets').filter((p: FlagPreset) => p.id !== presetId);
    store.set('presets', presets);
    return { success: true };
  });

  // History
  ipcMain.handle('history:list', () => {
    return store.get('history');
  });

  ipcMain.handle('history:getConfig', async (_event, historyId: string) => {
    const historyDir = getHistoryDir();
    const configPath = path.join(historyDir, historyId, 'config.json');
    
    if (!fs.existsSync(configPath)) {
      return { config: null, error: 'Config not found' };
    }
    
    const content = fs.readFileSync(configPath, 'utf-8');
    return { config: JSON.parse(content) as ConfigSnapshot, error: null };
  });

  ipcMain.handle('history:delete', async (_event, historyId: string) => {
    deleteHistoryFiles(historyId);
    const history = store.get('history').filter((h: HistoryEntry) => h.id !== historyId);
    store.set('history', history);
    return { success: true };
  });

  ipcMain.handle('history:getOutputPath', async (_event, { historyId, type }: { historyId: string; type: 'xlsx' | 'xlsxFormatted' }) => {
    const historyDir = getHistoryDir();
    const filename = type === 'xlsxFormatted' ? 'schedule-formatted.xlsx' : 'schedule.xlsx';
    const filePath = path.join(historyDir, historyId, filename);
    
    if (!fs.existsSync(filePath)) {
      return { path: null, exists: false };
    }
    
    return { path: filePath, exists: true };
  });

  // Solver
  ipcMain.handle('solver:run', async (_event, { config, snapshot }: { config: SolverRunConfig; snapshot: ConfigSnapshot }) => {
    if (activeSolverProcess) {
      return { error: 'A solver is already running', runId: null };
    }

    // Check Python availability before attempting to run
    const pythonCheck = await checkPythonAvailability();
    if (!pythonCheck.available) {
      return { error: pythonCheck.error || 'Python is not available', runId: null };
    }

    const runId = uuidv4();
    currentRunId = runId;
    solverStartTime = Date.now();
    solverMaxTime = config.maxSolveSeconds || 180;

    // Build command-line arguments
    const args = buildSolverArgs(config);
    const pythonPath = getPythonPath();
    const mainScript = getResourcePath('main.py');

    // Create history directory for outputs
    const historyDir = getHistoryDir();
    const outputDir = path.join(historyDir, runId);
    fs.mkdirSync(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, 'schedule.xlsx');
    args.push('--output', outputPath);
    args.push('--progress');

    console.log('Running solver:', pythonPath, [mainScript, ...args].join(' '));

    activeSolverProcess = spawn(pythonPath, [mainScript, ...args], {
      cwd: path.dirname(mainScript),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    // Send periodic progress updates based on elapsed time
    const progressInterval = setInterval(() => {
      if (!activeSolverProcess) {
        clearInterval(progressInterval);
        return;
      }
      const elapsed = (Date.now() - solverStartTime) / 1000;
      const estimatedPercent = Math.min(95, (elapsed / solverMaxTime) * 100);
      mainWindow?.webContents.send('solver:progress', {
        runId,
        percent: estimatedPercent,
        elapsed,
        maxTime: solverMaxTime,
      } as SolverProgress);
    }, 500);

    activeSolverProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      mainWindow?.webContents.send('solver:log', { runId, text, type: 'stdout' });
    });

    activeSolverProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      mainWindow?.webContents.send('solver:log', { runId, text, type: 'stderr' });
    });

    activeSolverProcess.on('close', (code: number | null) => {
      clearInterval(progressInterval);
      const elapsed = (Date.now() - solverStartTime) / 1000;
      
      if (code === 0) {
        // Success - check for output files
        const outputs: { xlsx?: string; xlsxFormatted?: string } = {};
        if (fs.existsSync(outputPath)) {
          outputs.xlsx = outputPath;
        }
        const formattedPath = outputPath.replace('.xlsx', '-formatted.xlsx');
        if (fs.existsSync(formattedPath)) {
          outputs.xlsxFormatted = formattedPath;
        }

        // Save history entry
        const historyEntry: HistoryEntry = {
          id: runId,
          timestamp: new Date().toISOString(),
          employeeCount: snapshot.staff.length,
          departmentCount: snapshot.departments.length,
          hasXlsx: !!outputs.xlsx,
          hasFormattedXlsx: !!outputs.xlsxFormatted,
          elapsed,
        };
        saveHistoryEntry(historyEntry, snapshot);

        mainWindow?.webContents.send('solver:done', {
          runId,
          success: true,
          outputs,
          elapsed,
        });
      } else {
        // Clean up failed run directory
        deleteHistoryFiles(runId);
        
        // Exit code 2 = no solution found (INFEASIBLE), distinct from 1 = exception
        const isNoSolution = code === 2;
        
        mainWindow?.webContents.send('solver:done', {
          runId,
          success: false,
          error: isNoSolution
            ? 'Could not create a valid schedule with the current settings. Check the suggestions below.'
            : `Solver encountered an unexpected error (code ${code}). Check the logs for details.`,
          errorType: isNoSolution ? 'no_solution' : 'error',
          elapsed,
        });
      }

      activeSolverProcess = null;
      currentRunId = null;
    });

    activeSolverProcess.on('error', (err: Error) => {
      clearInterval(progressInterval);
      deleteHistoryFiles(runId);
      
      mainWindow?.webContents.send('solver:error', {
        runId,
        error: err.message,
      });
      activeSolverProcess = null;
      currentRunId = null;
    });

    return { runId, error: null };
  });

  ipcMain.handle('solver:cancel', () => {
    if (activeSolverProcess) {
      activeSolverProcess.kill('SIGTERM');
      activeSolverProcess = null;
      const runId = currentRunId;
      if (runId) {
        deleteHistoryFiles(runId);
      }
      currentRunId = null;
      return { canceled: true, runId };
    }
    return { canceled: false, runId: null };
  });

  ipcMain.handle('solver:isRunning', () => {
    return { running: activeSolverProcess !== null, runId: currentRunId };
  });

  ipcMain.handle('solver:checkPython', async () => {
    return checkPythonAvailability();
  });

  // App info
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getPaths', () => {
    return {
      userData: app.getPath('userData'),
      temp: app.getPath('temp'),
      logs: app.getPath('logs'),
      history: getHistoryDir(),
    };
  });

  // ---------------------------------------------------------------------------
  // Updater
  // ---------------------------------------------------------------------------
  ipcMain.handle('updater:checkForUpdates', async () => {
    return checkForUpdates();
  });

  ipcMain.handle('updater:downloadAndInstall', async () => {
    await downloadAndInstallUpdate();
    return { success: true };
  });

  ipcMain.handle('updater:quitAndInstall', () => {
    quitAndInstall();
  });

  ipcMain.handle('updater:getStatus', () => {
    return getUpdateStatus();
  });
}

// ---------------------------------------------------------------------------
// Application Menu
// ---------------------------------------------------------------------------

function createApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Check for Updates...',
          click: () => triggerUpdateCheck(),
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' as const },
          { role: 'delete' as const },
          { role: 'selectAll' as const },
        ] : [
          { role: 'delete' as const },
          { type: 'separator' as const },
          { role: 'selectAll' as const },
        ]),
      ],
    },

    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
          { type: 'separator' as const },
          { role: 'window' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },

    // Help menu
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://charliec2004.github.io/semester-scheduler-UI/');
          },
        },
        {
          label: 'View on GitHub',
          click: async () => {
            await shell.openExternal('https://github.com/charliec2004/semester-scheduler-UI');
          },
        },
        ...(!isMac ? [
          { type: 'separator' as const },
          {
            label: 'Check for Updates...',
            click: () => triggerUpdateCheck(),
          },
        ] : []),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Trigger update check from menu and show appropriate dialog
 */
async function triggerUpdateCheck(): Promise<void> {
  const status = await checkForUpdates();

  if (status.state === 'available') {
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Update Available',
      message: `Version ${status.version} is available`,
      detail: status.releaseNotes || 'A new version of Scheduler is available. Would you like to download it now?',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      await downloadAndInstallUpdate();
    }
  } else if (status.state === 'not-available') {
    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'No Updates Available',
      message: 'You are running the latest version',
      detail: `Current version: ${app.getVersion()}`,
      buttons: ['OK'],
    });
  } else if (status.state === 'error') {
    dialog.showErrorBox('Update Check Failed', status.message);
  }
}

function buildSolverArgs(config: SolverRunConfig): string[] {
  const args: string[] = [config.staffPath, config.deptPath];

  if (config.maxSolveSeconds) {
    args.push('--max-solve-seconds', config.maxSolveSeconds.toString());
  }

  for (const [emp, mult] of Object.entries(config.favoredEmployees || {})) {
    args.push('--favor', mult !== 1.0 ? `${emp}:${mult}` : emp);
  }

  for (const training of config.trainingPairs || []) {
    args.push('--training', `${training.department},${training.trainee1},${training.trainee2}`);
  }

  for (const [dept, mult] of Object.entries(config.favoredDepartments || {})) {
    args.push('--favor-dept', mult !== 1.0 ? `${dept}:${mult}` : dept);
  }

  for (const [dept, mult] of Object.entries(config.favoredFrontDeskDepts || {})) {
    args.push('--favor-frontdesk-dept', mult !== 1.0 ? `${dept}:${mult}` : dept);
  }

  for (const fed of config.favoredEmployeeDepts || []) {
    const mult = fed.multiplier ?? 1.0;
    args.push('--favor-employee-dept', mult !== 1.0 
      ? `${fed.employee},${fed.department}:${mult}` 
      : `${fed.employee},${fed.department}`);
  }

  for (const ts of config.timesets || []) {
    args.push('--timeset', ts.employee, ts.day, ts.department, ts.startTime, ts.endTime);
  }

  for (const pref of config.shiftTimePreferences || []) {
    args.push('--shift-pref', `${pref.employee},${pref.day},${pref.preference}`);
  }

  for (const eq of config.equalityConstraints || []) {
    args.push('--equality', `${eq.department},${eq.employee1},${eq.employee2}`);
  }

  // Experimental: minimum department block enforcement
  if (config.enforceMinDeptBlock === false) {
    args.push('--no-enforce-min-dept-block');
  }

  // Settings overrides
  if (config.minSlots !== undefined) {
    args.push('--min-slots', config.minSlots.toString());
  }
  if (config.maxSlots !== undefined) {
    args.push('--max-slots', config.maxSlots.toString());
  }
  if (config.frontDeskCoverageWeight !== undefined) {
    args.push('--front-desk-weight', config.frontDeskCoverageWeight.toString());
  }
  if (config.departmentTargetWeight !== undefined) {
    args.push('--dept-target-weight', config.departmentTargetWeight.toString());
  }
  if (config.targetAdherenceWeight !== undefined) {
    args.push('--target-adherence-weight', config.targetAdherenceWeight.toString());
  }
  if (config.collaborativeHoursWeight !== undefined) {
    args.push('--collab-weight', config.collaborativeHoursWeight.toString());
  }
  if (config.shiftLengthWeight !== undefined) {
    args.push('--shift-length-weight', config.shiftLengthWeight.toString());
  }
  if (config.favoredEmployeeDeptWeight !== undefined) {
    args.push('--favor-emp-dept-weight', config.favoredEmployeeDeptWeight.toString());
  }
  if (config.departmentHourThreshold !== undefined) {
    args.push('--dept-hour-threshold', config.departmentHourThreshold.toString());
  }
  if (config.targetHardDeltaHours !== undefined) {
    args.push('--target-hard-delta', config.targetHardDeltaHours.toString());
  }

  return args;
}
