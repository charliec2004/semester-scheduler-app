/**
 * Vitest Setup File
 * Mocks Electron APIs for testing
 */

import { vi } from 'vitest';
import { DEFAULT_MAX_SLOTS, DEFAULT_MIN_SLOTS } from '../../shared/constants';

// Mock window.electronAPI
const mockElectronAPI = {
  files: {
    openCsv: vi.fn().mockResolvedValue({ canceled: true }),
    saveCsv: vi.fn().mockResolvedValue({ canceled: true }),
    downloadSample: vi.fn().mockResolvedValue({ canceled: true }),
    readFile: vi.fn().mockResolvedValue({ content: null, error: 'Not found' }),
    saveOutput: vi.fn().mockResolvedValue({ canceled: true }),
    openInExplorer: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    load: vi.fn().mockResolvedValue({
      solverMaxTime: 180,
      minSlots: DEFAULT_MIN_SLOTS,
      maxSlots: DEFAULT_MAX_SLOTS,
      frontDeskCoverageWeight: 10000,
      departmentTargetWeight: 1000,
      targetAdherenceWeight: 100,
      collaborativeHoursWeight: 200,
      shiftLengthWeight: 20,
      departmentHourThreshold: 4,
      targetHardDeltaHours: 5,
      highContrast: false,
      fontSize: 'medium',
    }),
    save: vi.fn().mockResolvedValue({ success: true }),
    reset: vi.fn().mockResolvedValue({}),
  },
  presets: {
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
  },
  solver: {
    run: vi.fn().mockResolvedValue({ runId: 'test-run', error: null }),
    cancel: vi.fn().mockResolvedValue({ canceled: true, runId: 'test-run' }),
    isRunning: vi.fn().mockResolvedValue({ running: false, runId: null }),
    onProgress: vi.fn().mockReturnValue(() => {}),
    onLog: vi.fn().mockReturnValue(() => {}),
    onDone: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
  },
  app: {
    getVersion: vi.fn().mockResolvedValue('1.0.2'),
    getPaths: vi.fn().mockResolvedValue({
      userData: '/tmp/userData',
      temp: '/tmp',
      logs: '/tmp/logs',
    }),
  },
};

// Set up global mock
Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  writable: true,
});

// Mock crypto.randomUUID
Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
  },
});
