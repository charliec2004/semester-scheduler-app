/**
 * Flags & Solve Tab Component
 * Configure solver flags and run the optimization
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import { 
  useFlagsStore, 
  useStaffStore, 
  useDepartmentStore, 
  useSolverStore, 
  useSettingsStore,
  useUIStore,
  createConfigSnapshot,
} from '../../store';
import type { TrainingPair, TimesetRequest, FlagPreset, FavoredEmployeeDept, ShiftTimePreference, EqualityConstraint, StaffMember } from '../../../main/ipc-types';
import { staffToCsv, departmentsToCsv } from '../../utils/csvValidators';
import { DAY_NAMES, DAY_END_MINUTES, SLOT_MINUTES, TIME_SLOT_STARTS } from '../../../shared/constants';

// Simple UUID generator for browser compatibility
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const TIME_OPTIONS = [...TIME_SLOT_STARTS, minutesToTimeLabel(DAY_END_MINUTES)];


function minutesToTimeLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

// Convert 24-hour time to 12-hour format for display
function to12Hour(time24: string): string {
  const [hourStr, min] = time24.split(':');
  const hour = parseInt(hourStr, 10);
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${min} ${period}`;
}

// Tooltip component with ? icon - uses fixed positioning to avoid clipping
function Tooltip({ text }: { text: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  
  const handleMouseEnter = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      // Position below the button, constrained to viewport
      const tooltipWidth = 256; // w-64 = 16rem = 256px
      let left = rect.left + rect.width / 2 - tooltipWidth / 2;
      // Keep tooltip within viewport with 8px padding
      left = Math.max(8, Math.min(left, window.innerWidth - tooltipWidth - 8));
      setCoords({
        top: rect.bottom + 8,
        left,
      });
    }
    setShow(true);
  };
  
  return (
    <span className="relative inline-flex items-center ml-1.5">
      <button
        ref={buttonRef}
        type="button"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setShow(false)}
        onFocus={handleMouseEnter}
        onBlur={() => setShow(false)}
        className="w-4 h-4 rounded-full bg-surface-700 text-surface-400 hover:bg-surface-600 hover:text-surface-300 flex items-center justify-center text-xs font-medium transition-colors"
        aria-label="More information"
      >
        ?
      </button>
      {show && (
        <div 
          className="fixed z-[100] px-3 py-2 text-xs text-surface-200 bg-surface-800 border border-surface-700 rounded-lg shadow-lg w-64 text-left"
          style={{ top: coords.top, left: coords.left }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

export function FlagsTab() {
  const {
    favoredEmployees, addFavoredEmployee, removeFavoredEmployee,
    trainingPairs, addTrainingPair, removeTrainingPair,
    favoredDepartments, setFavoredDepartments,
    favoredFrontDeskDepts, setFavoredFrontDeskDepts,
    favoredEmployeeDepts, addFavoredEmployeeDept, removeFavoredEmployeeDept,
    timesets, addTimeset, removeTimeset,
    shiftTimePreferences, addShiftTimePreference, removeShiftTimePreference,
    equalityConstraints, addEqualityConstraint, removeEqualityConstraint,
    maxSolveSeconds, setMaxSolveSeconds,
    presets, savePreset, applyPreset, deletePreset,
  } = useFlagsStore();
  
  const { staff, saveStaff, dirty: staffDirty } = useStaffStore();
  const { departments, saveDepartments, dirty: deptDirty } = useDepartmentStore();
  const { running, setRunning, reset } = useSolverStore();
  const { settings } = useSettingsStore();
  const { showToast, setActiveTab } = useUIStore();

  const [newFavored, setNewFavored] = useState('');
  const [newFavoredMultiplier, setNewFavoredMultiplier] = useState(1.0);
  const [newPresetName, setNewPresetName] = useState('');
  const [showPresetDialog, setShowPresetDialog] = useState(false);

  const employeeNames = useMemo(() => staff.map(s => s.name).filter(Boolean), [staff]);
  const departmentNames = useMemo(() => departments.map(d => d.name).filter(Boolean), [departments]);
  const staffWithNoRoles = useMemo(() => staff.filter(s => s.roles.length === 0), [staff]);

  const canRun = staff.length > 0 && departments.length > 0 && staffWithNoRoles.length === 0;

  const handleAddFavored = () => {
    if (newFavored && !(newFavored in favoredEmployees)) {
      addFavoredEmployee(newFavored, newFavoredMultiplier);
      setNewFavored('');
      setNewFavoredMultiplier(1.0);
    }
  };

  const handleSavePreset = async () => {
    if (!newPresetName.trim()) return;
    
    try {
      const preset: FlagPreset = {
        id: generateId(),
        name: newPresetName.trim(),
        favoredEmployees,
        trainingPairs,
        favoredDepartments,
        favoredFrontDeskDepts,
        favoredEmployeeDepts,
        timesets,
        shiftTimePreferences,
        equalityConstraints,
        maxSolveSeconds,
      };
      
      await savePreset(preset);
      setNewPresetName('');
      setShowPresetDialog(false);
      showToast('Preset saved', 'success');
    } catch (error) {
      console.error('Failed to save preset:', error);
      showToast('Failed to save preset', 'error');
    }
  };

  const handleRunSolver = async () => {
    if (!canRun) return;
    
    try {
      // Auto-save any unsaved changes before running
      if (staffDirty) {
        await saveStaff();
      }
      if (deptDirty) {
        await saveDepartments();
      }
      
      // Save CSVs to temp files
      const staffCsv = staffToCsv(staff);
      const deptCsv = departmentsToCsv(departments);
      
      const staffResult = await window.electronAPI.files.saveCsvToTemp({ 
        content: staffCsv, 
        filename: 'staff.csv' 
      });
      const deptResult = await window.electronAPI.files.saveCsvToTemp({ 
        content: deptCsv, 
        filename: 'departments.csv' 
      });

      // Create config snapshot for history
      const snapshot = createConfigSnapshot();

      // Clear previous result/error before starting
      reset();
      setRunning(true);
      
      const result = await window.electronAPI.solver.run({
        config: {
          staffPath: staffResult.path,
          deptPath: deptResult.path,
          maxSolveSeconds: maxSolveSeconds || settings?.solverMaxTime || 300,
          favoredEmployees,
          trainingPairs,
          favoredDepartments,
          favoredFrontDeskDepts,
          favoredEmployeeDepts,
          timesets,
          shiftTimePreferences,
          equalityConstraints,
          enforceMinDeptBlock: settings?.enforceMinDeptBlock ?? true,
          // Pass all settings to solver
          minSlots: settings?.minSlots,
          maxSlots: settings?.maxSlots,
          frontDeskCoverageWeight: settings?.frontDeskCoverageWeight,
          departmentTargetWeight: settings?.departmentTargetWeight,
          targetAdherenceWeight: settings?.targetAdherenceWeight,
          collaborativeHoursWeight: settings?.collaborativeHoursWeight,
          shiftLengthWeight: settings?.shiftLengthWeight,
          favoredEmployeeDeptWeight: settings?.favoredEmployeeDeptWeight,
          departmentHourThreshold: settings?.departmentHourThreshold,
          targetHardDeltaHours: settings?.targetHardDeltaHours,
        },
        snapshot,
      });

      if (result.error) {
        showToast(`Solver error: ${result.error}`, 'error');
        setRunning(false);
      } else {
        showToast('Solver started', 'info');
        setActiveTab('results');
      }
    } catch (err) {
      showToast(`Failed to start solver: ${(err as Error).message}`, 'error');
      setRunning(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-100 mb-1">
            Flags & Solve Configuration
          </h2>
          <p className="text-surface-400">
            Configure optimization preferences and run the scheduler
          </p>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={() => setShowPresetDialog(true)} 
            className="btn-secondary"
          >
            Save as Preset
          </button>
          <button
            onClick={handleRunSolver}
            disabled={!canRun || running}
            className="btn-primary"
          >
            {running ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Running...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Generate Schedule
              </>
            )}
          </button>
        </div>
      </div>

      {/* Warnings */}
      {!canRun && (
        <div className="bg-warning-500/10 border border-warning-500/30 rounded-lg p-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-warning-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="font-medium text-warning-400">Cannot Run Solver</p>
            <p className="text-sm text-warning-300 mt-1">
              {staff.length === 0 && 'Import or create staff data. '}
              {departments.length === 0 && 'Import or create department data. '}
              {staffWithNoRoles.length > 0 && (
                <>
                  {staffWithNoRoles.length === 1
                    ? `${staffWithNoRoles[0].name || 'An employee'} has no qualifications. `
                    : `${staffWithNoRoles.length} employees have no qualifications: ${staffWithNoRoles.slice(0, 3).map(s => s.name || 'Unnamed').join(', ')}${staffWithNoRoles.length > 3 ? '...' : ''}. `
                  }
                  Assign roles in the Staff tab.
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Presets */}
      {presets.length > 0 && (
        <div className="card">
          <h3 className="font-semibold text-surface-200 mb-4">Saved Presets</h3>
          <div className="flex flex-wrap gap-2">
            {presets.map(preset => (
              <div key={preset.id} className="flex items-stretch bg-surface-800 rounded-lg">
                <button
                  onClick={() => applyPreset(preset)}
                  className="px-3 py-1.5 text-sm hover:bg-surface-700/50 transition-colors rounded-l-lg"
                >
                  {preset.name}
                </button>
                <button
                  onClick={() => deletePreset(preset.id)}
                  className="px-2 flex items-center text-surface-400 hover:text-danger-400 hover:bg-danger-500/20 transition-colors rounded-r-lg"
                  aria-label={`Delete preset ${preset.name}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Favored Employees */}
        <div className="card">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Favored Employees
            <Tooltip text="Favored employees get higher priority to reach their target hours. Use the strength multiplier to control how strongly the solver favors them: 0.5x = weak, 1x = normal, 2x = strong, 3x = very strong." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Prioritize specific employees to hit their target hours
          </p>
          
          <div className="flex gap-2 mb-4 items-end">
            <div className="flex-1">
            <select
              value={newFavored}
              onChange={(e) => setNewFavored(e.target.value)}
                className="input w-full"
            >
              <option value="">Select employee...</option>
                {employeeNames.filter(n => !(n in favoredEmployees)).map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            </div>
            <div className="w-36 sm:w-40 flex-shrink-0">
              <div className="flex items-center gap-1 mb-1">
                <label className="text-xs text-surface-400">Strength</label>
                <MultiplierTooltip />
              </div>
              <select 
                value={newFavoredMultiplier} 
                onChange={(e) => setNewFavoredMultiplier(parseFloat(e.target.value))} 
                className="input w-full"
              >
                <option value={0.5}>0.5x Weak</option>
                <option value={1.0}>1.0x Normal</option>
                <option value={1.5}>1.5x Medium</option>
                <option value={2.0}>2.0x Strong</option>
                <option value={3.0}>3.0x Very Strong</option>
              </select>
            </div>
            <button 
              onClick={handleAddFavored}
              disabled={!newFavored}
              className="btn-secondary flex-shrink-0"
            >
              Add
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {Object.entries(favoredEmployees).map(([emp, mult]) => (
              <span key={emp} className="badge-success flex items-center gap-1">
                {emp}
                <span className="text-accent-300 opacity-75">({mult}x)</span>
                <button 
                  onClick={() => removeFavoredEmployee(emp)}
                  className="hover:text-danger-400"
                  aria-label={`Remove ${emp}`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
            {Object.keys(favoredEmployees).length === 0 && (
              <span className="text-sm text-surface-500">No favored employees</span>
            )}
          </div>
        </div>

        {/* Solver Time */}
        <div className="card">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Solver Time Limit
            <Tooltip text={<>The maximum time the optimizer will spend searching for the best schedule. Longer times may find better solutions but take longer. <span className="text-accent-400 font-medium">4-6 minutes</span> is recommended for most schedules.</>} />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Maximum time the optimizer will search for solutions
          </p>
          
          <div className="space-y-4">
            <input
              type="range"
              min="30"
              max="600"
              step="30"
              value={maxSolveSeconds}
              onChange={(e) => setMaxSolveSeconds(parseInt(e.target.value))}
              className="w-full accent-accent-500"
            />
            <div className="flex justify-between text-sm">
              <span className="text-surface-400">30 sec</span>
              <span className="font-medium text-accent-400">{maxSolveSeconds} seconds</span>
              <span className="text-surface-400">10 min</span>
            </div>
          </div>
        </div>

        {/* Training Pairs */}
        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Training Pairs
            <Tooltip text="Pairs two employees to work in the same department at overlapping times. Useful for training new employees by scheduling them alongside experienced staff." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Schedule employees to work together for training
          </p>
          
          <TrainingPairForm 
            departments={departmentNames}
            employees={employeeNames}
            staff={staff}
            onAdd={addTrainingPair}
          />

          <div className="space-y-2 mt-4">
            {trainingPairs.map((pair, i) => (
              <div key={i} className="flex items-center justify-between bg-surface-800 rounded-lg px-3 py-2">
                <span className="text-sm">
                  <span className="text-accent-400">{pair.department}</span>: {pair.trainee1} + {pair.trainee2}
                </span>
                <button 
                  onClick={() => removeTrainingPair(i)}
                  className="text-surface-400 hover:text-danger-400"
                  aria-label="Remove training pair"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Favor Department for Front Desk */}
        <div className="card">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Favor Departments for Front Desk
            <Tooltip text="When filling front desk shifts, prioritize employees from these departments. Use the strength multiplier to control priority when multiple departments are favored. Department members must be qualified for front desk." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Prioritize members of these departments to cover front desk shifts.
            At least one member must have front desk qualification.
          </p>
          
          <div className="space-y-2">
            {departmentNames.map(dept => {
              const isChecked = dept in favoredFrontDeskDepts;
              const mult = favoredFrontDeskDepts[dept] ?? 1.0;
              return (
                <div key={dept} className="flex items-center gap-3 hover:bg-surface-800 rounded-lg px-2 py-1.5 -mx-2 transition-colors">
                <input
                  type="checkbox"
                    checked={isChecked}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setFavoredFrontDeskDepts({ ...favoredFrontDeskDepts, [dept]: 1.0 });
                    } else {
                      const { [dept]: _removed, ...rest } = favoredFrontDeskDepts;
                      void _removed;
                      setFavoredFrontDeskDepts(rest);
                    }
                  }}
                    className="checkbox-dark"
                  />
                  <span className="text-sm text-surface-200 flex-1">{dept}</span>
                  {isChecked && (
                    <select
                      value={mult}
                      onChange={(e) => {
                        setFavoredFrontDeskDepts({ 
                          ...favoredFrontDeskDepts, 
                          [dept]: parseFloat(e.target.value) 
                        });
                      }}
                      className="input py-1 px-2 text-sm w-32 sm:w-36"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <option value={0.5}>0.5x Weak</option>
                      <option value={1.0}>1.0x Normal</option>
                      <option value={1.5}>1.5x Medium</option>
                      <option value={2.0}>2.0x Strong</option>
                      <option value={3.0}>3.0x Very Strong</option>
                    </select>
                  )}
                </div>
              );
            })}
            {departmentNames.length === 0 && (
              <span className="text-sm text-surface-500">No departments loaded</span>
            )}
          </div>
        </div>

        {/* Department Hour Priority */}
        <div className="card">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Department Hour Priority
            <Tooltip text="Increases the priority for these departments to meet their target hours. Use the strength multiplier to control how aggressively the solver targets these departments. Selected departments will get bonus points for focused work time." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Boost focused hours and target adherence for specific departments
          </p>
          
          <div className="space-y-2">
            {departmentNames.map(dept => {
              const isChecked = dept in favoredDepartments;
              const mult = favoredDepartments[dept] ?? 1.0;
              return (
                <div key={dept} className="flex items-center gap-3 hover:bg-surface-800 rounded-lg px-2 py-1.5 -mx-2 transition-colors">
                <input
                  type="checkbox"
                    checked={isChecked}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setFavoredDepartments({ ...favoredDepartments, [dept]: 1.0 });
                    } else {
                      const { [dept]: _removed, ...rest } = favoredDepartments;
                      void _removed;
                      setFavoredDepartments(rest);
                    }
                  }}
                    className="checkbox-dark"
                  />
                  <span className="text-sm text-surface-200 flex-1">{dept}</span>
                  {isChecked && (
                    <select
                      value={mult}
                      onChange={(e) => {
                        setFavoredDepartments({ 
                          ...favoredDepartments, 
                          [dept]: parseFloat(e.target.value) 
                        });
                      }}
                      className="input py-1 px-2 text-sm w-32 sm:w-36"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <option value={0.5}>0.5x Weak</option>
                      <option value={1.0}>1.0x Normal</option>
                      <option value={1.5}>1.5x Medium</option>
                      <option value={2.0}>2.0x Strong</option>
                      <option value={3.0}>3.0x Very Strong</option>
                    </select>
                  )}
                </div>
              );
            })}
            {departmentNames.length === 0 && (
              <span className="text-sm text-surface-500">No departments loaded</span>
            )}
          </div>
        </div>

        {/* Favor Employee for Department */}
        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Favor Employee for Department
            <Tooltip text="Adds a soft preference for an employee to work in a specific department or front desk. Use the multiplier to control strength: 0.5x = weak preference, 1x = normal, 2x = strong, 3x = very strong. The employee must be qualified for the role." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Softly prefer assigning specific employees to specific departments or front desk.
            The employee must be qualified for the role.
          </p>
          
          <FavoredEmployeeDeptForm
            employees={employeeNames}
            departments={departmentNames}
            staff={staff}
            onAdd={addFavoredEmployeeDept}
          />

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
            {favoredEmployeeDepts.map((fed, i) => (
              <div key={i} className="flex items-center justify-between bg-surface-800 rounded-lg px-3 py-2">
                <span className="text-sm">
                  <span className="font-medium text-surface-200">{fed.employee}</span>
                  <span className="text-surface-400"> → </span>
                  <span className="text-accent-400">{fed.department}</span>
                  <span className="text-surface-500 ml-1">({fed.multiplier || 1}x)</span>
                </span>
                <button 
                  onClick={() => removeFavoredEmployeeDept(i)}
                  className="text-surface-400 hover:text-danger-400 ml-2"
                  aria-label={`Remove ${fed.employee} → ${fed.department}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            {favoredEmployeeDepts.length === 0 && (
              <span className="text-sm text-surface-500">No employee-department preferences set</span>
            )}
          </div>
        </div>

        {/* Timesets - Force Employee to Role */}
        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Assign Employee to Role/Time
            <Tooltip text="Creates a hard requirement for an employee to work in a specific department at specific times. Unlike soft preferences, this will be enforced if possible. Use sparingly as too many constraints may make scheduling impossible." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Force a specific employee to work a role at specific times.
            Works with any department, even if the employee is not normally qualified.
          </p>
          
          <TimesetForm
            staff={staff}
            departments={departmentNames}
            onAdd={addTimeset}
          />

          <div className="grid sm:grid-cols-2 gap-2 mt-4">
            {timesets.map((ts, i) => (
              <div key={i} className="flex items-center justify-between bg-surface-800 rounded-lg px-3 py-2">
                <span className="text-sm">
                  <span className="font-medium text-surface-200">{ts.employee}</span>
                  <span className="text-surface-400"> → </span>
                  <span className="text-accent-400">{ts.department === 'front_desk' ? 'Front Desk' : ts.department}</span>
                  <span className="text-surface-400"> on </span>
                  <span>{ts.day} {to12Hour(ts.startTime)}-{to12Hour(ts.endTime)}</span>
                </span>
                <button 
                  onClick={() => removeTimeset(i)}
                  className="text-surface-400 hover:text-danger-400 ml-2"
                  aria-label="Remove timeset"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Equality - Equalize hours between two employees in a department */}
        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Equality
            <Tooltip text="Equalizes hours between two employees within a specific department only. Both employees must be qualified for the department and have the same target hours. The solver will try to give them equal time in that department, helping ensure fair distribution when two people should get the same opportunity." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Give two employees equal hours in a specific department
          </p>
          
          <EqualityForm
            departments={departmentNames}
            staff={staff}
            onAdd={addEqualityConstraint}
          />

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
            {equalityConstraints.map((eq, i) => (
              <div key={i} className="flex items-center justify-between bg-surface-800 rounded-lg px-3 py-2">
                <span className="text-sm">
                  <span className="text-accent-400">{eq.department}</span>
                  <span className="text-surface-400">: </span>
                  <span className="font-medium text-surface-200">{eq.employee1}</span>
                  <span className="text-surface-400"> = </span>
                  <span className="font-medium text-surface-200">{eq.employee2}</span>
                </span>
                <button 
                  onClick={() => removeEqualityConstraint(i)}
                  className="text-surface-400 hover:text-danger-400 ml-2"
                  aria-label={`Remove ${eq.employee1} = ${eq.employee2} equality`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            {equalityConstraints.length === 0 && (
              <span className="text-sm text-surface-500">No equality constraints set</span>
            )}
          </div>
        </div>

        {/* Shift Time Preferences */}
        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-surface-200 mb-2 flex items-center">
            Shift Time Preferences
            <Tooltip text="Softly nudge specific employees toward morning (8am-12pm) or afternoon (12pm-5pm) shifts on certain days. This is a gentle preference that won't override hard constraints, buffered availability, or travel-time trims." />
          </h3>
          <p className="text-sm text-surface-400 mb-4">
            Set soft preferences for when employees should work on specific days
          </p>
          
          <ShiftTimePreferenceForm
            employees={employeeNames}
            onAdd={addShiftTimePreference}
          />

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
            {shiftTimePreferences.map((pref, i) => (
              <div key={i} className="flex items-center justify-between bg-surface-800 rounded-lg px-3 py-2">
                <span className="text-sm">
                  <span className="font-medium text-surface-200">{pref.employee}</span>
                  <span className="text-surface-400"> on </span>
                  <span className="text-accent-400">{pref.day}</span>
                  <span className="text-surface-400"> → </span>
                  <span className={pref.preference === 'morning' ? 'text-warning-400' : 'text-blue-400'}>
                    {pref.preference === 'morning' ? 'Morning' : 'Afternoon'}
                  </span>
                </span>
                <button 
                  onClick={() => removeShiftTimePreference(i)}
                  className="text-surface-400 hover:text-danger-400 ml-2"
                  aria-label={`Remove ${pref.employee} ${pref.day} preference`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            {shiftTimePreferences.length === 0 && (
              <span className="text-sm text-surface-500">No shift time preferences set</span>
            )}
          </div>
        </div>
      </div>

      {/* Save Preset Dialog */}
      {showPresetDialog && (
        <PresetDialog
          value={newPresetName}
          onChange={setNewPresetName}
          onSave={handleSavePreset}
          onClose={() => setShowPresetDialog(false)}
        />
      )}
    </div>
  );
}

// Preset Dialog Component with Escape key support
function PresetDialog({
  value,
  onChange,
  onSave,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  // Lock main content scroll when modal is open
  useEffect(() => {
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContent.style.overflow = 'hidden';
    }
    return () => {
      if (mainContent) {
        mainContent.style.overflow = '';
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim()) {
      onSave();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-surface-950/80" onClick={onClose} />
      <div className="relative bg-surface-900 border border-surface-700 rounded-xl p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold text-surface-200 mb-4">Save Preset</h3>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Preset name..."
          className="input mb-4"
          autoFocus
        />
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button onClick={onSave} className="btn-primary" disabled={!value.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// Training Pair Form Component
function TrainingPairForm({ 
  departments, 
  employees, 
  staff,
  onAdd 
}: { 
  departments: string[]; 
  employees: string[]; 
  staff: StaffMember[];
  onAdd: (pair: TrainingPair) => void;
}) {
  const [dept, setDept] = useState('');
  const [trainee1, setTrainee1] = useState('');
  const [trainee2, setTrainee2] = useState('');

  // Filter employees who are qualified for the selected department
  const qualifiedEmployees = useMemo(() => {
    if (!dept) return [];
    return employees.filter(empName => {
      const staffMember = staff.find(s => s.name === empName);
      if (!staffMember) return false;
      // Check if employee has this department in their roles
      return staffMember.roles.some(role => 
        role.toLowerCase().replace(/\s+/g, '_') === dept.toLowerCase().replace(/\s+/g, '_')
      );
    });
  }, [dept, employees, staff]);

  const handleDeptChange = (newDept: string) => {
    setDept(newDept);
    // Reset trainees when department changes
    setTrainee1('');
    setTrainee2('');
  };

  const handleAdd = () => {
    if (dept && trainee1 && trainee2 && trainee1 !== trainee2) {
      onAdd({ department: dept, trainee1, trainee2 });
      setDept('');
      setTrainee1('');
      setTrainee2('');
    }
  };

  return (
    <div className="flex flex-wrap sm:flex-nowrap gap-2">
      <select value={dept} onChange={(e) => handleDeptChange(e.target.value)} className="input w-full sm:flex-1">
        <option value="">Department</option>
        {departments.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
      <select 
        value={trainee1} 
        onChange={(e) => setTrainee1(e.target.value)} 
        className="input w-[calc(50%-0.25rem)] sm:flex-1"
        disabled={!dept}
      >
        <option value="">Person 1</option>
        {qualifiedEmployees.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
      <select 
        value={trainee2} 
        onChange={(e) => setTrainee2(e.target.value)} 
        className="input w-[calc(50%-0.25rem)] sm:flex-1"
        disabled={!dept}
      >
        <option value="">Person 2</option>
        {qualifiedEmployees.filter(e => e !== trainee1).map(e => <option key={e} value={e}>{e}</option>)}
      </select>
      <button 
        onClick={handleAdd} 
        disabled={!dept || !trainee1 || !trainee2}
        className="btn-secondary flex-shrink-0 px-4 w-full sm:w-auto"
      >
        +
      </button>
    </div>
  );
}

// Timeset Form Component - Shows all departments (not just qualified ones)
function TimesetForm({
  staff,
  departments,
  onAdd,
}: {
  staff: StaffMember[];
  departments: string[];
  onAdd: (ts: TimesetRequest) => void;
}) {
  const [employee, setEmployee] = useState('');
  const [day, setDay] = useState('');
  const [department, setDepartment] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  // All departments plus Front Desk option
  const allRoles = useMemo(() => {
    const normalized = departments.map(d => d.toLowerCase().replace(/\s+/g, '_'));
    // Add front_desk if not already present
    if (!normalized.includes('front_desk')) {
      normalized.push('front_desk');
    }
    return normalized;
  }, [departments]);

  // Reset dependent fields when employee changes
  const handleEmployeeChange = (name: string) => {
    setEmployee(name);
    setDay('');
    setDepartment('');
    setStartTime('');
    setEndTime('');
  };

  // Reset time fields when department changes
  const handleDepartmentChange = (dept: string) => {
    setDepartment(dept);
    setStartTime('');
    setEndTime('');
  };

  const handleAdd = () => {
    if (employee && day && department && startTime && endTime) {
      onAdd({ employee, day, department, startTime, endTime });
      setEmployee('');
      setDay('');
      setDepartment('');
      setStartTime('');
      setEndTime('');
    }
  };

  const employeeNames = staff.map(s => s.name).filter(Boolean);

  return (
    <div className="grid grid-cols-6 gap-2">
      {/* 1. Employee - always enabled */}
      <select value={employee} onChange={(e) => handleEmployeeChange(e.target.value)} className="input">
        <option value="">Employee</option>
        {employeeNames.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
      
      {/* 2. Day - enabled after employee */}
      <select 
        value={day} 
        onChange={(e) => setDay(e.target.value)} 
        className="input"
        disabled={!employee}
      >
        <option value="">{employee ? 'Day' : 'Select employee first'}</option>
        {DAY_NAMES.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
      
      {/* 3. Department - enabled after employee, shows all departments */}
      <select
        value={department}
        onChange={(e) => handleDepartmentChange(e.target.value)}
        className="input"
        disabled={!employee}
      >
        <option value="">{employee ? 'Role' : 'Select employee first'}</option>
        {allRoles.map(role => (
          <option key={role} value={role}>
            {role === 'front_desk' ? 'Front Desk' : role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
          </option>
        ))}
      </select>
      
      {/* 4. Start time - enabled after department */}
      <select 
        value={startTime} 
        onChange={(e) => { setStartTime(e.target.value); setEndTime(''); }} 
        className="input"
        disabled={!department}
      >
        <option value="">{department ? 'Start' : 'Select role first'}</option>
        {TIME_OPTIONS.slice(0, -1).map(t => <option key={t} value={t}>{to12Hour(t)}</option>)}
      </select>
      
      {/* 5. End time - enabled after start time */}
      <select 
        value={endTime} 
        onChange={(e) => setEndTime(e.target.value)} 
        className="input"
        disabled={!startTime}
      >
        <option value="">{startTime ? 'End' : 'Select start first'}</option>
        {TIME_OPTIONS.filter(t => t > startTime).map(t => <option key={t} value={t}>{to12Hour(t)}</option>)}
      </select>
      
      {/* 6. Add button */}
      <button 
        onClick={handleAdd}
        disabled={!employee || !day || !department || !startTime || !endTime}
        className="btn-secondary"
      >
        Add
      </button>
    </div>
  );
}

// Shift Time Preference Form Component
function ShiftTimePreferenceForm({
  employees,
  onAdd,
}: {
  employees: string[];
  onAdd: (pref: ShiftTimePreference) => void;
}) {
  const [employee, setEmployee] = useState('');
  const [day, setDay] = useState('');
  const [preference, setPreference] = useState<'morning' | 'afternoon'>('morning');

  const handleAdd = () => {
    if (employee && day) {
      onAdd({ employee, day, preference });
      setEmployee('');
      setDay('');
      setPreference('morning');
    }
  };

  return (
    <div className="flex flex-wrap sm:flex-nowrap gap-2">
      <select 
        value={employee} 
        onChange={(e) => setEmployee(e.target.value)} 
        className="input w-full sm:flex-1"
      >
        <option value="">Employee</option>
        {employees.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
      <select 
        value={day} 
        onChange={(e) => setDay(e.target.value)} 
        className="input w-[calc(50%-0.25rem)] sm:w-36"
      >
        <option value="">Day</option>
        {DAY_NAMES.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
      <select 
        value={preference} 
        onChange={(e) => setPreference(e.target.value as 'morning' | 'afternoon')} 
        className="input w-[calc(50%-0.25rem)] sm:w-56"
      >
        <option value="morning">Morning (8-12)</option>
        <option value="afternoon">Afternoon (12-5)</option>
      </select>
      <button 
        onClick={handleAdd}
        disabled={!employee || !day}
        className="btn-secondary flex-shrink-0 px-4 w-full sm:w-auto"
      >
        Add
      </button>
    </div>
  );
}

// Multiplier tooltip for the form
function MultiplierTooltip() {
  const [show, setShow] = useState(false);
  
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        className="w-4 h-4 rounded-full bg-surface-700 text-surface-400 hover:bg-surface-600 hover:text-surface-300 flex items-center justify-center text-xs font-medium transition-colors"
        aria-label="Multiplier explanation"
      >
        ?
      </button>
      {show && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-surface-200 bg-surface-800 border border-surface-700 rounded-lg shadow-lg w-56 text-left">
          <strong className="text-accent-400">Multiplier Strength:</strong>
          <ul className="mt-1 space-y-0.5">
            <li><span className="text-surface-400">0.5x</span> - Weak preference</li>
            <li><span className="text-surface-400">1.0x</span> - Normal (default)</li>
            <li><span className="text-surface-400">2.0x</span> - Strong preference</li>
            <li><span className="text-surface-400">3.0x</span> - Very strong</li>
          </ul>
          <p className="mt-1.5 text-surface-400">Higher = solver tries harder to assign this employee to this role.</p>
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <div className="border-4 border-transparent border-t-surface-800" />
          </div>
        </div>
      )}
    </span>
  );
}

// Favored Employee-Department Form Component
function FavoredEmployeeDeptForm({
  employees,
  departments,
  staff,
  onAdd,
}: {
  employees: string[];
  departments: string[];
  staff: StaffMember[];
  onAdd: (fed: FavoredEmployeeDept) => void;
}) {
  const [employee, setEmployee] = useState('');
  const [department, setDepartment] = useState('');
  const [multiplier, setMultiplier] = useState(1.0);

  // Get departments + front_desk the selected employee is qualified for
  const qualifiedRoles = useMemo(() => {
    if (!employee) return [];
    const staffMember = staff.find(s => s.name === employee);
    if (!staffMember) return [];
    
    const roles: string[] = [];
    
    // Check if qualified for front_desk
    if (staffMember.roles.some(role => 
      role.toLowerCase().replace(/\s+/g, '_') === 'front_desk'
    )) {
      roles.push('front_desk');
    }
    
    // Add departments the employee is qualified for
    departments.forEach(dept => {
      if (staffMember.roles.some(role => 
        role.toLowerCase().replace(/\s+/g, '_') === dept.toLowerCase().replace(/\s+/g, '_')
      )) {
        roles.push(dept);
      }
    });
    
    return roles;
  }, [employee, staff, departments]);

  const handleAdd = () => {
    if (employee && department) {
      onAdd({ employee, department, multiplier });
      setEmployee('');
      setDepartment('');
      setMultiplier(1.0);
    }
  };

  return (
    <div className="flex gap-2 items-end">
      <div className="flex-1">
        <select value={employee} onChange={(e) => { setEmployee(e.target.value); setDepartment(''); }} className="input w-full">
        <option value="">Select employee...</option>
        {employees.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
      </div>
      <div className="flex-1">
      <select 
        value={department} 
        onChange={(e) => setDepartment(e.target.value)} 
          className="input w-full"
        disabled={!employee}
      >
        <option value="">{employee ? 'Select role...' : 'Select employee first'}</option>
        {qualifiedRoles.map(d => (
          <option key={d} value={d}>
              {d === 'front_desk' ? 'Front Desk' : d}
          </option>
        ))}
      </select>
      </div>
      <div className="w-36 sm:w-40 flex-shrink-0">
        <div className="flex items-center gap-1 mb-1">
          <label className="text-xs text-surface-400">Strength</label>
          <MultiplierTooltip />
        </div>
        <select 
          value={multiplier} 
          onChange={(e) => setMultiplier(parseFloat(e.target.value))} 
          className="input w-full"
        >
          <option value={0.5}>0.5x Weak</option>
          <option value={1.0}>1.0x Normal</option>
          <option value={1.5}>1.5x Medium</option>
          <option value={2.0}>2.0x Strong</option>
          <option value={3.0}>3.0x Very Strong</option>
        </select>
      </div>
      <button 
        onClick={handleAdd}
        disabled={!employee || !department}
        className="btn-secondary flex-shrink-0"
      >
        Add
      </button>
    </div>
  );
}

// Equality Form Component - Left-to-right input with target hours validation
function EqualityForm({
  departments,
  staff,
  onAdd,
}: {
  departments: string[];
  staff: StaffMember[];
  onAdd: (eq: EqualityConstraint) => void;
}) {
  const [department, setDepartment] = useState('');
  const [employee1, setEmployee1] = useState('');
  const [employee2, setEmployee2] = useState('');
  const [validationError, setValidationError] = useState('');

  // Get employees qualified for the selected department
  const qualifiedEmployees = useMemo(() => {
    if (!department) return [];
    return staff.filter(s => {
      // Check if employee has this department in their roles
      return s.roles.some(role => 
        role.toLowerCase().replace(/\s+/g, '_') === department.toLowerCase().replace(/\s+/g, '_')
      );
    });
  }, [department, staff]);

  // Get qualified employee names (excluding already selected employee1)
  const qualifiedNames1 = useMemo(() => qualifiedEmployees.map(e => e.name), [qualifiedEmployees]);
  const qualifiedNames2 = useMemo(() => 
    qualifiedEmployees.filter(e => e.name !== employee1).map(e => e.name), 
    [qualifiedEmployees, employee1]
  );

  // Validate target hours match
  useEffect(() => {
    if (employee1 && employee2) {
      const emp1Data = staff.find(s => s.name === employee1);
      const emp2Data = staff.find(s => s.name === employee2);
      if (emp1Data && emp2Data && emp1Data.targetHours !== emp2Data.targetHours) {
        setValidationError(`Target hours mismatch: ${employee1} has ${emp1Data.targetHours}hrs, ${employee2} has ${emp2Data.targetHours}hrs`);
      } else {
        setValidationError('');
      }
    } else {
      setValidationError('');
    }
  }, [employee1, employee2, staff]);

  const handleDepartmentChange = (dept: string) => {
    setDepartment(dept);
    setEmployee1('');
    setEmployee2('');
    setValidationError('');
  };

  const handleEmployee1Change = (emp: string) => {
    setEmployee1(emp);
    setEmployee2('');
  };

  const handleAdd = () => {
    if (department && employee1 && employee2 && !validationError) {
      onAdd({ department, employee1, employee2 });
      setDepartment('');
      setEmployee1('');
      setEmployee2('');
      setValidationError('');
    }
  };

  const canAdd = department && employee1 && employee2 && !validationError;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap sm:flex-nowrap gap-2">
        {/* 1. Department - always enabled */}
        <select 
          value={department} 
          onChange={(e) => handleDepartmentChange(e.target.value)} 
          className="input w-full sm:flex-1"
        >
          <option value="">Department</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        
        {/* 2. Employee 1 - enabled after department */}
        <select 
          value={employee1} 
          onChange={(e) => handleEmployee1Change(e.target.value)} 
          className="input w-full sm:flex-1"
          disabled={!department}
        >
          <option value="">{department ? 'Person 1' : 'Select department first'}</option>
          {qualifiedNames1.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        
        {/* 3. Employee 2 - enabled after employee 1 */}
        <select 
          value={employee2} 
          onChange={(e) => setEmployee2(e.target.value)} 
          className="input w-full sm:flex-1"
          disabled={!employee1}
        >
          <option value="">{employee1 ? 'Person 2' : 'Select person 1 first'}</option>
          {qualifiedNames2.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        
        {/* 4. Add button */}
        <button 
          onClick={handleAdd}
          disabled={!canAdd}
          className="btn-secondary flex-shrink-0 px-4 w-full sm:w-auto"
        >
          Add
        </button>
      </div>
      
      {/* Validation error message */}
      {validationError && (
        <div className="text-sm text-danger-400 flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {validationError}
        </div>
      )}
    </div>
  );
}
