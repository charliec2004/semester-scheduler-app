/**
 * Shared IPC type definitions for main and renderer processes.
 * These types define the contract between Electron main and the React renderer.
 */

import type { DayName, DayTravelBuffer } from '../shared/constants';
import { DEFAULT_MAX_SLOTS, DEFAULT_MIN_SLOTS } from '../shared/constants';

// ---------------------------------------------------------------------------
// Settings & Configuration
// ---------------------------------------------------------------------------

export interface AppSettings {
  // Solver
  solverMaxTime: number;
  minSlots: number;
  maxSlots: number;
  
  // Objective weights
  frontDeskCoverageWeight: number;
  departmentTargetWeight: number;
  targetAdherenceWeight: number;
  collaborativeHoursWeight: number;
  shiftLengthWeight: number;
  favoredEmployeeDeptWeight: number;
  
  // Thresholds
  departmentHourThreshold: number;
  targetHardDeltaHours: number;
  
  // UI preferences
  highContrast: boolean;
  fontSize: 'small' | 'medium' | 'large';
  
  // Experimental
  enforceMinDeptBlock: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  solverMaxTime: 180,
  minSlots: DEFAULT_MIN_SLOTS,
  maxSlots: DEFAULT_MAX_SLOTS,
  frontDeskCoverageWeight: 10000,
  departmentTargetWeight: 1000,
  targetAdherenceWeight: 100,
  collaborativeHoursWeight: 200,
  shiftLengthWeight: 20,
  favoredEmployeeDeptWeight: 50,
  departmentHourThreshold: 4,
  targetHardDeltaHours: 5,
  highContrast: false,
  fontSize: 'medium',
  enforceMinDeptBlock: true,
};

function looksLikeLegacySlotSettings(stored?: Partial<AppSettings> | null): boolean {
  if (stored?.minSlots === undefined || stored?.maxSlots === undefined) {
    return false;
  }
  return (
    Number.isFinite(stored.minSlots) &&
    Number.isFinite(stored.maxSlots) &&
    stored.minSlots > 0 &&
    stored.maxSlots > 0 &&
    stored.minSlots < DEFAULT_MIN_SLOTS &&
    stored.maxSlots <= DEFAULT_MAX_SLOTS
  );
}

export function normalizeAppSettings(stored?: Partial<AppSettings> | null): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...stored };
  if (looksLikeLegacySlotSettings(stored)) {
    merged.minSlots = Math.round((stored?.minSlots ?? DEFAULT_MIN_SLOTS) * 3);
    merged.maxSlots = Math.round((stored?.maxSlots ?? DEFAULT_MAX_SLOTS) * 3);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// CSV Data Models
// ---------------------------------------------------------------------------

export interface StaffMember {
  name: string;
  roles: string[];
  targetHours: number;
  maxHours: number;
  year: number;
  availability: Record<string, boolean>; // e.g., "Mon_08:00" -> true
  travelBuffers: Record<DayName, DayTravelBuffer>;
}

export interface Department {
  name: string;
  targetHours: number;
  maxHours: number;
}

// ---------------------------------------------------------------------------
// Solver Configuration
// ---------------------------------------------------------------------------

export interface TrainingPair {
  department: string;
  trainee1: string;
  trainee2: string;
}

export interface TimesetRequest {
  employee: string;
  day: string;
  department: string;
  startTime: string;
  endTime: string;
}

export interface FavoredEmployeeDept {
  employee: string;
  department: string;
  multiplier: number; // Strength of preference (0.5 = half, 1.0 = normal, 2.0 = double)
}

export interface ShiftTimePreference {
  employee: string;
  day: string; // Mon, Tue, Wed, Thu, Fri
  preference: 'morning' | 'afternoon'; // morning = 8am-12pm, afternoon = 12pm-5pm
}

export interface EqualityConstraint {
  department: string;
  employee1: string;
  employee2: string;
}

export interface SolverRunConfig {
  staffPath: string;
  deptPath: string;
  maxSolveSeconds?: number;
  showProgress?: boolean;
  favoredEmployees?: Record<string, number>; // employee name -> multiplier
  trainingPairs?: TrainingPair[];
  favoredDepartments?: Record<string, number>;
  favoredFrontDeskDepts?: Record<string, number>;
  timesets?: TimesetRequest[];
  favoredEmployeeDepts?: FavoredEmployeeDept[];
  shiftTimePreferences?: ShiftTimePreference[];
  equalityConstraints?: EqualityConstraint[];
  enforceMinDeptBlock?: boolean; // Default true, disable to allow 1-hour dept blocks
  // Settings overrides (from Settings panel)
  minSlots?: number;
  maxSlots?: number;
  frontDeskCoverageWeight?: number;
  departmentTargetWeight?: number;
  targetAdherenceWeight?: number;
  collaborativeHoursWeight?: number;
  shiftLengthWeight?: number;
  favoredEmployeeDeptWeight?: number;
  departmentHourThreshold?: number;
  targetHardDeltaHours?: number;
}

export interface SolverProgress {
  runId: string;
  percent: number;
  elapsed: number;
  maxTime: number;
  message?: string;
}

export interface SolverResult {
  runId: string;
  success: boolean;
  outputs?: {
    xlsx?: string;
    xlsxFormatted?: string;
  };
  error?: string;
  errorType?: 'error' | 'no_solution';  // 'no_solution' = yellow warning (constraints too restrictive)
  elapsed: number;
}

// ---------------------------------------------------------------------------
// History & Config Snapshots
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  timestamp: string;
  employeeCount: number;
  departmentCount: number;
  hasXlsx: boolean;
  hasFormattedXlsx: boolean;
  elapsed: number;
}

export interface ConfigSnapshot {
  staff: StaffMember[];
  departments: Department[];
  favoredEmployees: Record<string, number>; // employee name -> multiplier
  trainingPairs: TrainingPair[];
  favoredDepartments: Record<string, number>;
  favoredFrontDeskDepts: Record<string, number>;
  timesets: TimesetRequest[];
  favoredEmployeeDepts: FavoredEmployeeDept[];
  shiftTimePreferences: ShiftTimePreference[];
  equalityConstraints: EqualityConstraint[];
  maxSolveSeconds: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  row?: number;
  column?: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  data?: StaffMember[] | Department[];
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface FlagPreset {
  id: string;
  name: string;
  description?: string;
  favoredEmployees: Record<string, number>; // employee name -> multiplier
  trainingPairs: TrainingPair[];
  favoredDepartments: Record<string, number>;
  favoredFrontDeskDepts: Record<string, number>;
  timesets: TimesetRequest[];
  favoredEmployeeDepts: FavoredEmployeeDept[];
  shiftTimePreferences: ShiftTimePreference[];
  equalityConstraints: EqualityConstraint[];
  maxSolveSeconds?: number;
}

// ---------------------------------------------------------------------------
// IPC Channel Definitions
// ---------------------------------------------------------------------------

export interface IpcChannels {
  // Files
  'files:openCsv': (kind: 'staff' | 'dept') => Promise<{ path?: string; content?: string; canceled: boolean }>;
  'files:saveCsvToTemp': (opts: { content: string; filename: string }) => Promise<{ path: string }>;
  'files:saveCsv': (opts: { kind: 'staff' | 'dept'; content: string }) => Promise<{ path?: string; canceled: boolean }>;
  'files:downloadSample': (kind: 'staff' | 'dept') => Promise<{ path?: string; canceled: boolean }>;
  'files:readFile': (path: string) => Promise<{ content: string | null; error: string | null }>;
  'files:saveOutputAs': (opts: { sourcePath: string; defaultName: string }) => Promise<{ path?: string; canceled: boolean }>;
  'files:openInExplorer': (path: string) => Promise<void>;
  
  // Settings
  'settings:load': () => Promise<AppSettings>;
  'settings:save': (settings: AppSettings) => Promise<{ success: boolean }>;
  'settings:reset': () => Promise<AppSettings>;
  
  // Presets
  'presets:list': () => Promise<FlagPreset[]>;
  'presets:save': (preset: FlagPreset) => Promise<{ success: boolean }>;
  'presets:delete': (presetId: string) => Promise<{ success: boolean }>;
  
  // History
  'history:list': () => Promise<HistoryEntry[]>;
  'history:getConfig': (historyId: string) => Promise<{ config: ConfigSnapshot | null; error: string | null }>;
  'history:delete': (historyId: string) => Promise<{ success: boolean }>;
  'history:getOutputPath': (opts: { historyId: string; type: 'xlsx' | 'xlsxFormatted' }) => Promise<{ path: string | null; exists: boolean }>;
  
  // Solver
  'solver:run': (opts: { config: SolverRunConfig; snapshot: ConfigSnapshot }) => Promise<{ runId: string | null; error: string | null }>;
  'solver:cancel': () => Promise<{ canceled: boolean; runId: string | null }>;
  'solver:isRunning': () => Promise<{ running: boolean; runId: string | null }>;
  
  // App
  'app:getVersion': () => Promise<string>;
  'app:getPaths': () => Promise<{ userData: string; temp: string; logs: string; history: string }>;
}

// Event channels (main -> renderer)
export interface IpcEvents {
  'solver:progress': SolverProgress;
  'solver:log': { runId: string; text: string; type: 'stdout' | 'stderr' };
  'solver:done': SolverResult;
  'solver:error': { runId: string; error: string };
}
