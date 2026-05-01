/**
 * Global state management using Zustand
 * Manages app settings, CSV data, solver state, and UI state
 */

import { create } from 'zustand';
import type {
  AppSettings,
  StaffMember,
  Department,
  FlagPreset,
  TrainingPair,
  TimesetRequest,
  FavoredEmployeeDept,
  ShiftTimePreference,
  EqualityConstraint,
  SolverProgress,
  ValidationError,
  HistoryEntry,
  ConfigSnapshot,
} from '../../main/ipc-types';
import {
  createDefaultTravelBuffers,
  DAY_NAMES,
  normalizeAvailabilityMap,
} from '../../shared/constants';


function normalizeStaffMember(member: StaffMember): StaffMember {
  const defaultTravelBuffers = createDefaultTravelBuffers();
  return {
    ...member,
    availability: normalizeAvailabilityMap(member.availability),
    travelBuffers: Object.fromEntries(
      DAY_NAMES.map(day => [
        day,
        {
          beforeNextCommitment: member.travelBuffers?.[day]?.beforeNextCommitment ?? defaultTravelBuffers[day].beforeNextCommitment,
          afterPreviousCommitment: member.travelBuffers?.[day]?.afterPreviousCommitment ?? defaultTravelBuffers[day].afterPreviousCommitment,
        },
      ]),
    ) as StaffMember['travelBuffers'],
  };
}

// ---------------------------------------------------------------------------
// Settings Store
// ---------------------------------------------------------------------------

interface SettingsState {
  settings: AppSettings | null;
  loading: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  resetSettings: () => Promise<AppSettings>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: true,

  loadSettings: async () => {
    set({ loading: true });
    const settings = await window.electronAPI.settings.load();
    set({ settings, loading: false });
  },

  saveSettings: async (settings) => {
    await window.electronAPI.settings.save(settings);
    set({ settings });
  },

  resetSettings: async () => {
    const settings = await window.electronAPI.settings.reset();
    set({ settings });
    return settings;
  },
}));

// ---------------------------------------------------------------------------
// Staff Data Store
// ---------------------------------------------------------------------------

interface StaffState {
  staff: StaffMember[];
  staffPath: string | null;
  errors: ValidationError[];
  warnings: ValidationError[];
  dirty: boolean;
  setStaff: (staff: StaffMember[], path?: string) => void;
  updateStaffMember: (index: number, member: Partial<StaffMember>) => void;
  addStaffMember: (member: StaffMember) => void;
  removeStaffMember: (index: number) => void;
  removeRoleFromAllStaff: (role: string) => void;
  setErrors: (errors: ValidationError[], warnings: ValidationError[]) => void;
  setDirty: (dirty: boolean) => void;
  clearStaff: () => void;
  saveStaff: () => Promise<void>;
  loadSavedStaff: () => Promise<void>;
}

export const useStaffStore = create<StaffState>((set, get) => ({
  staff: [],
  staffPath: null,
  errors: [],
  warnings: [],
  dirty: false,

  setStaff: (staff, path) => set({ staff: staff.map(normalizeStaffMember), staffPath: path ?? null, dirty: false }),
  
  updateStaffMember: (index, member) => {
    const staff = [...get().staff];
    staff[index] = normalizeStaffMember({ ...staff[index], ...member });
    set({ staff, dirty: true });
  },

  addStaffMember: (member) => {
    set({ staff: [...get().staff, normalizeStaffMember(member)], dirty: true });
  },

  removeStaffMember: (index) => {
    const staff = get().staff.filter((_, i) => i !== index);
    set({ staff, dirty: true });
  },

  removeRoleFromAllStaff: (role) => {
    const staff = get().staff.map(member => ({
      ...member,
      roles: member.roles.filter(r => r !== role),
    }));
    set({ staff, dirty: true });
  },

  setErrors: (errors, warnings) => set({ errors, warnings }),
  setDirty: (dirty) => set({ dirty }),
  clearStaff: () => set({ staff: [], staffPath: null, errors: [], warnings: [], dirty: false }),
  
  saveStaff: async () => {
    await window.electronAPI.data.saveStaff(get().staff);
    set({ dirty: false });
  },
  
  loadSavedStaff: async () => {
    const staff = await window.electronAPI.data.loadStaff();
    if (staff && staff.length > 0) {
      set({ staff: staff.map(normalizeStaffMember), dirty: false });
    }
  },
}));

// ---------------------------------------------------------------------------
// Department Data Store
// ---------------------------------------------------------------------------

interface DepartmentState {
  departments: Department[];
  deptPath: string | null;
  errors: ValidationError[];
  warnings: ValidationError[];
  dirty: boolean;
  setDepartments: (departments: Department[], path?: string) => void;
  updateDepartment: (index: number, dept: Partial<Department>) => void;
  addDepartment: (dept: Department) => void;
  removeDepartment: (index: number) => void;
  reorderDepartments: (fromIndex: number, toIndex: number) => void;
  setErrors: (errors: ValidationError[], warnings: ValidationError[]) => void;
  setDirty: (dirty: boolean) => void;
  clearDepartments: () => void;
  saveDepartments: () => Promise<void>;
  loadSavedDepartments: () => Promise<void>;
}

export const useDepartmentStore = create<DepartmentState>((set, get) => ({
  departments: [],
  deptPath: null,
  errors: [],
  warnings: [],
  dirty: false,

  setDepartments: (departments, path) => set({ departments, deptPath: path ?? null, dirty: false }),
  
  updateDepartment: (index, dept) => {
    const departments = [...get().departments];
    departments[index] = { ...departments[index], ...dept };
    set({ departments, dirty: true });
  },

  addDepartment: (dept) => {
    set({ departments: [...get().departments, dept], dirty: true });
  },

  removeDepartment: (index) => {
    const deptToRemove = get().departments[index];
    const departments = get().departments.filter((_, i) => i !== index);
    set({ departments, dirty: true });
    // Also remove this department's role from all staff members
    if (deptToRemove) {
      const normalizedRole = deptToRemove.name.toLowerCase().replace(/\s+/g, '_');
      useStaffStore.getState().removeRoleFromAllStaff(normalizedRole);
    }
  },

  reorderDepartments: (fromIndex, toIndex) => {
    const departments = [...get().departments];
    const [removed] = departments.splice(fromIndex, 1);
    departments.splice(toIndex, 0, removed);
    set({ departments, dirty: true });
  },

  setErrors: (errors, warnings) => set({ errors, warnings }),
  setDirty: (dirty) => set({ dirty }),
  clearDepartments: () => set({ departments: [], deptPath: null, errors: [], warnings: [], dirty: false }),
  
  saveDepartments: async () => {
    await window.electronAPI.data.saveDepartments(get().departments);
    set({ dirty: false });
  },
  
  loadSavedDepartments: async () => {
    const departments = await window.electronAPI.data.loadDepartments();
    if (departments && departments.length > 0) {
      set({ departments, dirty: false });
    }
  },
}));

// ---------------------------------------------------------------------------
// Flags/Solve Configuration Store
// ---------------------------------------------------------------------------

interface FlagsState {
  favoredEmployees: Record<string, number>; // employee name -> multiplier
  trainingPairs: TrainingPair[];
  favoredDepartments: Record<string, number>;
  favoredFrontDeskDepts: Record<string, number>;
  favoredEmployeeDepts: FavoredEmployeeDept[];
  timesets: TimesetRequest[];
  shiftTimePreferences: ShiftTimePreference[];
  equalityConstraints: EqualityConstraint[];
  maxSolveSeconds: number;
  presets: FlagPreset[];
  
  setFavoredEmployees: (employees: Record<string, number>) => void;
  addFavoredEmployee: (employee: string, multiplier: number) => void;
  removeFavoredEmployee: (employee: string) => void;
  
  setTrainingPairs: (pairs: TrainingPair[]) => void;
  addTrainingPair: (pair: TrainingPair) => void;
  removeTrainingPair: (index: number) => void;
  
  setFavoredDepartments: (depts: Record<string, number>) => void;
  setFavoredFrontDeskDepts: (depts: Record<string, number>) => void;
  
  setFavoredEmployeeDepts: (depts: FavoredEmployeeDept[]) => void;
  addFavoredEmployeeDept: (dept: FavoredEmployeeDept) => void;
  removeFavoredEmployeeDept: (index: number) => void;
  
  setTimesets: (timesets: TimesetRequest[]) => void;
  addTimeset: (timeset: TimesetRequest) => void;
  removeTimeset: (index: number) => void;
  
  setShiftTimePreferences: (prefs: ShiftTimePreference[]) => void;
  addShiftTimePreference: (pref: ShiftTimePreference) => void;
  removeShiftTimePreference: (index: number) => void;
  
  setEqualityConstraints: (constraints: EqualityConstraint[]) => void;
  addEqualityConstraint: (constraint: EqualityConstraint) => void;
  removeEqualityConstraint: (index: number) => void;
  
  setMaxSolveSeconds: (seconds: number) => void;
  
  loadPresets: () => Promise<void>;
  savePreset: (preset: FlagPreset) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  applyPreset: (preset: FlagPreset) => void;
  clearPresets: () => void;
  
  reset: () => void;
}

export const useFlagsStore = create<FlagsState>((set, get) => ({
  favoredEmployees: {},
  trainingPairs: [],
  favoredDepartments: {},
  favoredFrontDeskDepts: {},
  favoredEmployeeDepts: [],
  timesets: [],
  shiftTimePreferences: [],
  equalityConstraints: [],
  maxSolveSeconds: 300,
  presets: [],

  setFavoredEmployees: (employees) => set({ favoredEmployees: employees }),
  addFavoredEmployee: (employee, multiplier) => {
    if (!(employee in get().favoredEmployees)) {
      set({ favoredEmployees: { ...get().favoredEmployees, [employee]: multiplier } });
    }
  },
  removeFavoredEmployee: (employee) => {
    const { [employee]: _removed, ...rest } = get().favoredEmployees;
    void _removed;
    set({ favoredEmployees: rest });
  },

  setTrainingPairs: (pairs) => set({ trainingPairs: pairs }),
  addTrainingPair: (pair) => set({ trainingPairs: [...get().trainingPairs, pair] }),
  removeTrainingPair: (index) => {
    set({ trainingPairs: get().trainingPairs.filter((_, i) => i !== index) });
  },

  setFavoredDepartments: (depts) => set({ favoredDepartments: depts }),
  setFavoredFrontDeskDepts: (depts) => set({ favoredFrontDeskDepts: depts }),

  setFavoredEmployeeDepts: (depts) => set({ favoredEmployeeDepts: depts }),
  addFavoredEmployeeDept: (dept) => {
    // Prevent duplicates
    const exists = get().favoredEmployeeDepts.some(
      d => d.employee === dept.employee && d.department === dept.department
    );
    if (!exists) {
      set({ favoredEmployeeDepts: [...get().favoredEmployeeDepts, dept] });
    }
  },
  removeFavoredEmployeeDept: (index) => {
    set({ favoredEmployeeDepts: get().favoredEmployeeDepts.filter((_, i) => i !== index) });
  },

  setTimesets: (timesets) => set({ timesets }),
  addTimeset: (timeset) => set({ timesets: [...get().timesets, timeset] }),
  removeTimeset: (index) => {
    set({ timesets: get().timesets.filter((_, i) => i !== index) });
  },

  setShiftTimePreferences: (prefs) => set({ shiftTimePreferences: prefs }),
  addShiftTimePreference: (pref) => {
    // Prevent duplicates (same employee + day)
    const exists = get().shiftTimePreferences.some(
      p => p.employee === pref.employee && p.day === pref.day
    );
    if (!exists) {
      set({ shiftTimePreferences: [...get().shiftTimePreferences, pref] });
    }
  },
  removeShiftTimePreference: (index) => {
    set({ shiftTimePreferences: get().shiftTimePreferences.filter((_, i) => i !== index) });
  },

  setEqualityConstraints: (constraints) => set({ equalityConstraints: constraints }),
  addEqualityConstraint: (constraint) => {
    // Prevent duplicates (same department + employees in either order)
    const exists = get().equalityConstraints.some(
      c => c.department === constraint.department && 
           ((c.employee1 === constraint.employee1 && c.employee2 === constraint.employee2) ||
            (c.employee1 === constraint.employee2 && c.employee2 === constraint.employee1))
    );
    if (!exists) {
      set({ equalityConstraints: [...get().equalityConstraints, constraint] });
    }
  },
  removeEqualityConstraint: (index) => {
    set({ equalityConstraints: get().equalityConstraints.filter((_, i) => i !== index) });
  },

  setMaxSolveSeconds: (seconds) => set({ maxSolveSeconds: seconds }),

  loadPresets: async () => {
    const presets = await window.electronAPI.presets.list();
    set({ presets });
  },

  savePreset: async (preset) => {
    await window.electronAPI.presets.save(preset);
    await get().loadPresets();
  },

  deletePreset: async (presetId) => {
    await window.electronAPI.presets.delete(presetId);
    await get().loadPresets();
  },

  applyPreset: (preset) => {
    set({
      favoredEmployees: preset.favoredEmployees,
      trainingPairs: preset.trainingPairs,
      favoredDepartments: preset.favoredDepartments,
      favoredFrontDeskDepts: preset.favoredFrontDeskDepts,
      favoredEmployeeDepts: preset.favoredEmployeeDepts || [],
      timesets: preset.timesets,
      shiftTimePreferences: preset.shiftTimePreferences || [],
      equalityConstraints: preset.equalityConstraints || [],
      maxSolveSeconds: preset.maxSolveSeconds ?? get().maxSolveSeconds,
    });
  },

  clearPresets: () => set({ presets: [] }),

  reset: () => set({
    favoredEmployees: {},
    trainingPairs: [],
    favoredDepartments: {},
    favoredFrontDeskDepts: {},
    favoredEmployeeDepts: [],
    timesets: [],
    shiftTimePreferences: [],
    equalityConstraints: [],
    maxSolveSeconds: 300,
  }),
}));

// ---------------------------------------------------------------------------
// History Store
// ---------------------------------------------------------------------------

interface HistoryState {
  history: HistoryEntry[];
  loading: boolean;
  loadHistory: () => Promise<void>;
  deleteEntry: (historyId: string) => Promise<void>;
  restoreConfig: (historyId: string) => Promise<boolean>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  history: [],
  loading: false,

  loadHistory: async () => {
    set({ loading: true });
    const history = await window.electronAPI.history.list();
    set({ history, loading: false });
  },

  deleteEntry: async (historyId) => {
    await window.electronAPI.history.delete(historyId);
    set({ history: get().history.filter(h => h.id !== historyId) });
  },

  restoreConfig: async (historyId) => {
    const result = await window.electronAPI.history.getConfig(historyId);
    if (result.config) {
      const config = result.config;
      // Restore all stores
      useStaffStore.getState().setStaff(config.staff);
      useDepartmentStore.getState().setDepartments(config.departments);
      useFlagsStore.getState().setFavoredEmployees(config.favoredEmployees);
      useFlagsStore.getState().setTrainingPairs(config.trainingPairs);
      useFlagsStore.getState().setFavoredDepartments(config.favoredDepartments);
      useFlagsStore.getState().setFavoredFrontDeskDepts(config.favoredFrontDeskDepts);
      useFlagsStore.getState().setFavoredEmployeeDepts(config.favoredEmployeeDepts || []);
      useFlagsStore.getState().setTimesets(config.timesets);
      useFlagsStore.getState().setShiftTimePreferences(config.shiftTimePreferences || []);
      useFlagsStore.getState().setEqualityConstraints(config.equalityConstraints || []);
      useFlagsStore.getState().setMaxSolveSeconds(config.maxSolveSeconds);
      return true;
    }
    return false;
  },
}));

// ---------------------------------------------------------------------------
// Solver State Store
// ---------------------------------------------------------------------------

interface SolverState {
  running: boolean;
  runId: string | null;
  progress: SolverProgress | null;
  logs: Array<{ text: string; type: 'stdout' | 'stderr'; timestamp: number }>;
  result: {
    success: boolean;
    outputs?: { xlsx?: string; xlsxFormatted?: string };
    error?: string;
    errorType?: 'error' | 'no_solution';  // 'no_solution' = yellow warning, 'error' = red error
    elapsed: number;
  } | null;
  
  setRunning: (running: boolean, runId?: string) => void;
  setProgress: (progress: SolverProgress) => void;
  addLog: (text: string, type: 'stdout' | 'stderr') => void;
  setResult: (result: SolverState['result']) => void;
  reset: () => void;
}

export const useSolverStore = create<SolverState>((set, get) => ({
  running: false,
  runId: null,
  progress: null,
  logs: [],
  result: null,

  setRunning: (running, runId) => set({ running, runId: runId ?? null }),
  setProgress: (progress) => set({ progress }),
  addLog: (text, type) => {
    set({ logs: [...get().logs, { text, type, timestamp: Date.now() }] });
  },
  setResult: (result) => set({ result, running: false }),
  reset: () => set({ running: false, runId: null, progress: null, logs: [], result: null }),
}));

// ---------------------------------------------------------------------------
// UI State Store
// ---------------------------------------------------------------------------

type TabId = 'import' | 'staff' | 'departments' | 'flags' | 'results' | 'settings';

interface UIState {
  activeTab: TabId;
  showSettings: boolean;
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
  
  setActiveTab: (tab: TabId) => void;
  setShowSettings: (show: boolean) => void;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  hideToast: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: 'import',
  showSettings: false,
  toast: null,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setShowSettings: (show) => set({ showSettings: show }),
  showToast: (message, type) => {
    set({ toast: { message, type } });
    setTimeout(() => set({ toast: null }), 4000);
  },
  hideToast: () => set({ toast: null }),
}));

// ---------------------------------------------------------------------------
// Helper: Create Config Snapshot
// ---------------------------------------------------------------------------

export function createConfigSnapshot(): ConfigSnapshot {
  const staff = useStaffStore.getState().staff;
  const departments = useDepartmentStore.getState().departments;
  const flags = useFlagsStore.getState();
  
  return {
    staff,
    departments,
    favoredEmployees: flags.favoredEmployees,
    trainingPairs: flags.trainingPairs,
    favoredDepartments: flags.favoredDepartments,
    favoredFrontDeskDepts: flags.favoredFrontDeskDepts,
    favoredEmployeeDepts: flags.favoredEmployeeDepts,
    timesets: flags.timesets,
    shiftTimePreferences: flags.shiftTimePreferences,
    equalityConstraints: flags.equalityConstraints,
    maxSolveSeconds: flags.maxSolveSeconds,
  };
}
