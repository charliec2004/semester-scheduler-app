/**
 * Settings Panel Component
 * Slide-out panel for configuring solver parameters and UI preferences
 */

import { useState, useEffect, useRef } from 'react';
import { useSettingsStore, useUIStore, useStaffStore, useDepartmentStore, useFlagsStore } from '../../store';
import type { AppSettings } from '../../../main/ipc-types';
import { DEFAULT_MAX_SLOTS, DEFAULT_MIN_SLOTS, SLOT_MINUTES, TIME_SLOT_STARTS } from '../../../shared/constants';

// Tooltip component with ? icon - uses fixed positioning to avoid clipping
function Tooltip({ text }: { text: string }) {
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

type UpdateStatus = 
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseNotes?: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export function SettingsPanel() {
  const { settings, saveSettings, resetSettings } = useSettingsStore();
  const { setShowSettings, showToast } = useUIStore();
  const [localSettings, setLocalSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const isMac = navigator.platform.toLowerCase().includes('mac');

  // Fetch app version from Electron (reads from package.json)
  useEffect(() => {
    window.electronAPI.app.getVersion().then(setAppVersion).catch(() => setAppVersion('unknown'));
  }, []);

  // Listen for update status changes
  useEffect(() => {
    const unsubscribe = window.electronAPI.updater.onStatusChange(setUpdateStatus);
    return () => { unsubscribe(); };
  }, []);

  useEffect(() => {
    if (settings) {
      setLocalSettings({ ...settings });
    }
  }, [settings]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => {
    setShowSettings(false);
  };

  const handleSave = async () => {
    if (!localSettings) return;
    setSaving(true);
    try {
      // Ensure all numeric values have valid defaults before saving
      const validatedSettings: AppSettings = {
        ...localSettings,
        minSlots: isNaN(localSettings.minSlots) ? DEFAULT_MIN_SLOTS : localSettings.minSlots,
        maxSlots: isNaN(localSettings.maxSlots) ? DEFAULT_MAX_SLOTS : localSettings.maxSlots,
        frontDeskCoverageWeight: isNaN(localSettings.frontDeskCoverageWeight) ? 10000 : localSettings.frontDeskCoverageWeight,
        departmentTargetWeight: isNaN(localSettings.departmentTargetWeight) ? 1000 : localSettings.departmentTargetWeight,
        targetAdherenceWeight: isNaN(localSettings.targetAdherenceWeight) ? 100 : localSettings.targetAdherenceWeight,
        collaborativeHoursWeight: isNaN(localSettings.collaborativeHoursWeight) ? 200 : localSettings.collaborativeHoursWeight,
        shiftLengthWeight: isNaN(localSettings.shiftLengthWeight) ? 20 : localSettings.shiftLengthWeight,
        favoredEmployeeDeptWeight: isNaN(localSettings.favoredEmployeeDeptWeight) ? 50 : localSettings.favoredEmployeeDeptWeight,
        departmentHourThreshold: isNaN(localSettings.departmentHourThreshold) ? 4 : localSettings.departmentHourThreshold,
        targetHardDeltaHours: isNaN(localSettings.targetHardDeltaHours) ? 5 : localSettings.targetHardDeltaHours,
      };
      await saveSettings(validatedSettings);
      showToast('Settings saved successfully', 'success');
      handleClose();
    } catch (err) {
      showToast('Failed to save settings', 'error');
    }
    setSaving(false);
  };

  const handleReset = async () => {
    const confirmed = window.confirm('Reset all settings to defaults?');
    if (confirmed) {
      try {
        const newSettings = await resetSettings();
        setLocalSettings(newSettings);
        await saveSettings(newSettings);
        showToast('Settings reset to defaults', 'success');
      } catch (err) {
        console.error('Failed to reset settings:', err);
        showToast('Failed to reset settings', 'error');
      }
    }
  };

  const handleClearAllData = async () => {
    const confirmed = window.confirm(
      'This will clear all staff, departments, and presets. History will be preserved. Are you sure?'
    );
    if (confirmed) {
      try {
        const result = await window.electronAPI.data.clearAll();
        if (result.success) {
          // Clear the in-memory stores
          useStaffStore.getState().clearStaff();
          useDepartmentStore.getState().clearDepartments();
          useFlagsStore.getState().clearPresets();
          useFlagsStore.getState().reset();
          showToast('All data cleared', 'success');
          handleClose();
        } else {
          showToast('Failed to clear data', 'error');
        }
      } catch (err) {
        console.error('Failed to clear data:', err);
        showToast('Failed to clear data', 'error');
      }
    }
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (localSettings) {
      setLocalSettings({ ...localSettings, [key]: value });
    }
  };

  // Handle number input changes - allow empty/invalid values during typing
  const handleNumberChange = (key: keyof AppSettings, value: string) => {
    if (localSettings) {
      // Store as number if valid, otherwise store NaN to allow clearing
      const num = value === '' ? NaN : parseInt(value);
      setLocalSettings({ ...localSettings, [key]: num as AppSettings[typeof key] });
    }
  };

  // Apply default value on blur if field is empty/invalid
  const handleNumberBlur = (key: keyof AppSettings, defaultValue: number) => {
    if (localSettings) {
      const current = localSettings[key];
      if (typeof current !== 'number' || isNaN(current)) {
        setLocalSettings({ ...localSettings, [key]: defaultValue as AppSettings[typeof key] });
      }
    }
  };

  // Get display value for number inputs (show empty string for NaN)
  const getNumberValue = (value: number): string => {
    return isNaN(value) ? '' : String(value);
  };

  const handleCheckForUpdates = async () => {
    try {
      const status = await window.electronAPI.updater.checkForUpdates();
      
      if (status.state === 'available') {
        showToast(`Update available: v${status.version}`, 'success');
      } else if (status.state === 'not-available') {
        showToast('You are running the latest version', 'success');
      } else if (status.state === 'error') {
        showToast(`Update check failed: ${status.message}`, 'error');
      }
    } catch (err) {
      console.error('Update check failed:', err);
      showToast('Failed to check for updates', 'error');
    }
  };

  const handleDownloadUpdate = async () => {
    try {
      await window.electronAPI.updater.downloadAndInstall();
    } catch (err) {
      console.error('Download failed:', err);
      showToast('Failed to download update', 'error');
    }
  };

  const handleInstallUpdate = () => {
    window.electronAPI.updater.quitAndInstall();
  };

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

  if (!localSettings) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-surface-950/80 backdrop-blur-sm"
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div 
        className="relative w-full max-w-md bg-surface-900 border-l border-surface-700 overflow-y-auto animate-slide-in-right"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        {/* Header */}
        <div className="sticky top-0 z-[60] bg-surface-900 border-b border-surface-700 px-6 py-4 flex items-center justify-between">
          <h2 id="settings-title" className="text-lg font-display font-semibold">Settings</h2>
          <button 
            onClick={handleClose}
            className="btn-ghost p-2"
            aria-label="Close settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-8">
          {/* Solver Settings */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Solver Configuration
            </h3>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label" htmlFor="minSlots">
                    Min Shift Slots
                    <Tooltip text={`Minimum shift length in ${SLOT_MINUTES}-minute slots. A value of ${DEFAULT_MIN_SLOTS} means shifts must be at least 2 hours long.`} />
                  </label>
                  <input
                    id="minSlots"
                    type="number"
                    min="1"
                    max={TIME_SLOT_STARTS.length}
                    value={getNumberValue(localSettings.minSlots)}
                    onChange={(e) => handleNumberChange('minSlots', e.target.value)}
                    onBlur={() => handleNumberBlur('minSlots', DEFAULT_MIN_SLOTS)}
                    className="input"
                  />
                  <p className="text-xs text-surface-500 mt-1">{SLOT_MINUTES}-min slots</p>
                </div>

                <div>
                  <label className="label" htmlFor="maxSlots">
                    Max Shift Slots
                    <Tooltip text={`Maximum shift length in ${SLOT_MINUTES}-minute slots. A value of ${DEFAULT_MAX_SLOTS} means shifts can be up to 4 hours long.`} />
                  </label>
                  <input
                    id="maxSlots"
                    type="number"
                    min="1"
                    max={TIME_SLOT_STARTS.length}
                    value={getNumberValue(localSettings.maxSlots)}
                    onChange={(e) => handleNumberChange('maxSlots', e.target.value)}
                    onBlur={() => handleNumberBlur('maxSlots', DEFAULT_MAX_SLOTS)}
                    className="input"
                  />
                  <p className="text-xs text-surface-500 mt-1">{SLOT_MINUTES}-min slots</p>
                </div>
              </div>
            </div>
          </section>

          {/* Objective Weights */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Objective Weights
              <Tooltip text="These weights control how the solver prioritizes different objectives. Higher values mean stronger priority. Adjust carefully—extreme values can lead to imbalanced schedules." />
            </h3>
            <p className="text-xs text-surface-500 mb-4">
              Higher values give more priority to each objective
            </p>
            <div className="space-y-4">
              <div>
                <label className="label" htmlFor="frontDeskCoverageWeight">
                  Front Desk Coverage
                  <Tooltip text="Priority for ensuring front desk is always staffed during operating hours. This should usually be the highest weight to guarantee coverage." />
                </label>
                <input
                  id="frontDeskCoverageWeight"
                  type="number"
                  min="0"
                  max="50000"
                  step="1000"
                  value={getNumberValue(localSettings.frontDeskCoverageWeight)}
                  onChange={(e) => handleNumberChange('frontDeskCoverageWeight', e.target.value)}
                  onBlur={() => handleNumberBlur('frontDeskCoverageWeight', 10000)}
                  className="input"
                />
              </div>

              <div>
                <label className="label" htmlFor="departmentTargetWeight">
                  Department Target Adherence
                  <Tooltip text="Priority for meeting each department's target hours. Higher values make the solver work harder to staff departments at their target levels." />
                </label>
                <input
                  id="departmentTargetWeight"
                  type="number"
                  min="0"
                  max="5000"
                  step="100"
                  value={getNumberValue(localSettings.departmentTargetWeight)}
                  onChange={(e) => handleNumberChange('departmentTargetWeight', e.target.value)}
                  onBlur={() => handleNumberBlur('departmentTargetWeight', 1000)}
                  className="input"
                />
              </div>

              <div>
                <label className="label" htmlFor="targetAdherenceWeight">
                  Employee Target Adherence
                  <Tooltip text="Priority for scheduling employees close to their individual target hours. Balances workload across the team." />
                </label>
                <input
                  id="targetAdherenceWeight"
                  type="number"
                  min="0"
                  max="500"
                  step="10"
                  value={getNumberValue(localSettings.targetAdherenceWeight)}
                  onChange={(e) => handleNumberChange('targetAdherenceWeight', e.target.value)}
                  onBlur={() => handleNumberBlur('targetAdherenceWeight', 100)}
                  className="input"
                />
              </div>

              <div>
                <label className="label" htmlFor="collaborativeHoursWeight">
                  Collaborative Hours
                  <Tooltip text="Bonus for scheduling multiple employees in the same department at the same time. Encourages teamwork and training opportunities." />
                </label>
                <input
                  id="collaborativeHoursWeight"
                  type="number"
                  min="0"
                  max="1000"
                  step="50"
                  value={getNumberValue(localSettings.collaborativeHoursWeight)}
                  onChange={(e) => handleNumberChange('collaborativeHoursWeight', e.target.value)}
                  onBlur={() => handleNumberBlur('collaborativeHoursWeight', 200)}
                  className="input"
                />
              </div>

              <div>
                <label className="label" htmlFor="shiftLengthWeight">
                  Shift Length Bonus
                  <Tooltip text="Small bonus for longer shifts. Encourages the solver to create fewer, longer shifts rather than many short ones." />
                </label>
                <input
                  id="shiftLengthWeight"
                  type="number"
                  min="0"
                  max="100"
                  step="5"
                  value={getNumberValue(localSettings.shiftLengthWeight)}
                  onChange={(e) => handleNumberChange('shiftLengthWeight', e.target.value)}
                  onBlur={() => handleNumberBlur('shiftLengthWeight', 20)}
                  className="input"
                />
              </div>

              <div>
                <label className="label" htmlFor="favoredEmployeeDeptWeight">
                  Favor Employee for Department
                </label>
                <input
                  id="favoredEmployeeDeptWeight"
                  type="number"
                  min="0"
                  max="200"
                  step="10"
                  value={getNumberValue(localSettings.favoredEmployeeDeptWeight)}
                  onChange={(e) => handleNumberChange('favoredEmployeeDeptWeight', e.target.value)}
                  onBlur={() => handleNumberBlur('favoredEmployeeDeptWeight', 50)}
                  className="input"
                />
                <p className="text-xs text-surface-500 mt-1">
                  Bonus per slot when favored employee works preferred dept
                </p>
              </div>
            </div>
          </section>

          {/* Thresholds */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Thresholds
              <Tooltip text="These values define acceptable ranges. Setting them too tight may make scheduling impossible; too loose may produce poor results." />
            </h3>
            <div className="space-y-4">
              <div>
                <label className="label" htmlFor="departmentHourThreshold">
                  Department Hour Wiggle Room
                  <Tooltip text="Departments can be staffed within +/- this many hours of their target. Provides flexibility when perfect staffing isn't possible." />
                </label>
                <input
                  id="departmentHourThreshold"
                  type="number"
                  min="0"
                  max="10"
                  value={getNumberValue(localSettings.departmentHourThreshold)}
                  onChange={(e) => handleNumberChange('departmentHourThreshold', e.target.value)}
                  onBlur={() => handleNumberBlur('departmentHourThreshold', 4)}
                  className="input"
                />
                <p className="text-xs text-surface-500 mt-1">
                  Allowable +/- hours from department targets
                </p>
              </div>

              <div>
                <label className="label" htmlFor="targetHardDeltaHours">
                  Employee Hour Band
                  <Tooltip text="Hard constraint: employees must be scheduled within +/- this many hours of their target. Prevents over- or under-scheduling individuals." />
                </label>
                <input
                  id="targetHardDeltaHours"
                  type="number"
                  min="1"
                  max="10"
                  value={getNumberValue(localSettings.targetHardDeltaHours)}
                  onChange={(e) => handleNumberChange('targetHardDeltaHours', e.target.value)}
                  onBlur={() => handleNumberBlur('targetHardDeltaHours', 5)}
                  className="input"
                />
                <p className="text-xs text-surface-500 mt-1">
                  Keep employees within +/- hours of their target
                </p>
              </div>
            </div>
          </section>

          {/* UI Preferences */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Accessibility
              <Tooltip text="Visual preferences to improve readability and usability for different needs." />
            </h3>
            <div className="space-y-4">
              <div>
                <label className="label" htmlFor="fontSize">Font Size</label>
                <select
                  id="fontSize"
                  value={localSettings.fontSize}
                  onChange={(e) => updateSetting('fontSize', e.target.value as 'small' | 'medium' | 'large')}
                  className="input"
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="highContrast"
                  checked={localSettings.highContrast}
                  onChange={(e) => updateSetting('highContrast', e.target.checked)}
                  className="checkbox-dark"
                />
                <label htmlFor="highContrast" className="text-surface-200">
                  High contrast mode
                </label>
              </div>
            </div>
          </section>

          {/* Experimental Features */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Experimental Features
              <Tooltip text="These features are experimental and may change in future versions." />
            </h3>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="enforceMinDeptBlock"
                  checked={localSettings.enforceMinDeptBlock}
                  onChange={(e) => updateSetting('enforceMinDeptBlock', e.target.checked)}
                  className="checkbox-dark flex-shrink-0"
                />
                <label htmlFor="enforceMinDeptBlock" className="text-surface-200">
                  Enforce 2-hour minimum department blocks
                </label>
                <Tooltip text="When enabled, non-Front-Desk department assignments must be at least 2 hours. Prevents awkward 1-hour fragments within shifts. Favored employees are partially exempt but cannot split a 2-hour shift across two departments." />
              </div>
            </div>
          </section>

          {/* Data Management */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Data Management
            </h3>
            <div className="space-y-3">
              <p className="text-sm text-surface-400">
                Clear all saved staff, departments, and presets. History will be preserved.
              </p>
              <button
                onClick={handleClearAllData}
                className="btn-ghost text-red-400 hover:text-red-300 hover:bg-red-900/20 w-full border border-red-900/50"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Clear All Data
              </button>
            </div>
          </section>

          {/* Updates */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Updates
            </h3>
            <div className="space-y-3">
              {/* Status display */}
              {updateStatus.state === 'downloading' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-surface-400">Downloading update...</span>
                    <span className="text-surface-300">{Math.round(updateStatus.percent)}%</span>
                  </div>
                  <div className="h-1.5 bg-surface-700 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-accent-500 transition-all duration-300"
                      style={{ width: `${updateStatus.percent}%` }}
                    />
                  </div>
                  {isMac && (
                    <p className="text-xs text-surface-500 mt-2">
                      Once complete, the installer will open automatically.
                    </p>
                  )}
                </div>
              )}
              
              {updateStatus.state === 'available' && (
                <div className="p-3 bg-accent-900/20 border border-accent-700/50 rounded-lg">
                  <p className="text-sm text-accent-300 font-medium mb-2">
                    Version {updateStatus.version} available!
                  </p>
                  {isMac ? (
                    <div className="text-xs mb-3 space-y-2">
                      <p className="text-surface-400">
                        This will download the installer to your Downloads folder and open it. 
                        Drag the app to Applications to replace the old version.
                      </p>
                      <p className="text-red-400 font-medium">
                        ⚠️ Important: After installing, open Terminal and run:
                      </p>
                      <code className="block bg-surface-950 text-surface-300 px-2 py-1 rounded text-xs font-mono">
                        xattr -cr /Applications/Scheduler.app
                      </code>
                    </div>
                  ) : (
                    <p className="text-xs text-surface-400 mb-3">
                      The update will download in the background. Once complete, click &quot;Restart and Install&quot; 
                      to automatically update and relaunch the app.
                    </p>
                  )}
                  <button
                    onClick={handleDownloadUpdate}
                    className="btn-primary w-full text-sm"
                  >
                    Download Update
                  </button>
                </div>
              )}
              
              {updateStatus.state === 'downloaded' && (
                <div className="p-3 bg-green-900/20 border border-green-700/50 rounded-lg">
                  <p className="text-sm text-green-300 font-medium mb-2">
                    Version {updateStatus.version} ready to install
                  </p>
                  <p className="text-xs text-surface-400 mb-3">
                    The app will close and relaunch automatically with the new version.
                  </p>
                  <button
                    onClick={handleInstallUpdate}
                    className="btn-primary w-full text-sm bg-green-600 hover:bg-green-500"
                  >
                    Restart and Install
                  </button>
                </div>
              )}
              
              {updateStatus.state === 'error' && (
                <div className="p-3 bg-red-900/20 border border-red-700/50 rounded-lg">
                  <p className="text-sm text-red-400">
                    {updateStatus.message}
                  </p>
                </div>
              )}
              
              {(updateStatus.state === 'idle' || updateStatus.state === 'not-available' || updateStatus.state === 'checking') && (
                <button
                  onClick={handleCheckForUpdates}
                  disabled={updateStatus.state === 'checking'}
                  className={`btn-ghost w-full border border-surface-700 ${
                    updateStatus.state === 'checking' ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  {updateStatus.state === 'checking' ? (
                    <>
                      <svg className="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Checking...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Check for Updates
                    </>
                  )}
                </button>
              )}
              
              {updateStatus.state === 'not-available' && (
                <p className="text-xs text-surface-500 text-center">
                  You&apos;re on the latest version
                </p>
              )}
            </div>
          </section>

          {/* Feedback */}
          <section>
            <h3 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-4">
              Feedback
            </h3>
            <a
              href="https://github.com/charliec2004/semester-scheduler-UI/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost w-full border border-surface-700 text-surface-300 hover:text-surface-100"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Report a Bug
            </a>
            <p className="text-xs text-surface-500 mt-2 text-center">
              View or report issues on GitHub
            </p>
          </section>

          {/* Version Info */}
          <div className="pt-4 mt-4 border-t border-surface-800">
            <p className="text-xs text-surface-500 text-center">
              Semester Scheduler v{appVersion}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-surface-900 border-t border-surface-700 px-6 py-4 flex gap-3">
          <button
            onClick={handleReset}
            className="btn-ghost flex-1"
          >
            Reset to Defaults
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary flex-1"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
