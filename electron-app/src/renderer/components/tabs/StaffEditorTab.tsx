/**
 * Staff Editor Tab Component
 * Grid-based editor for employees with availability matrix
 */

import { useState, useMemo } from 'react';
import { useStaffStore, useDepartmentStore, useUIStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { staffToCsv, AVAILABILITY_COLUMNS } from '../../utils/csvValidators';
import {
  COMMON_ROLES,
  createDefaultTravelBuffers,
  DAY_NAMES,
  SLOT_MINUTES,
  TIME_SLOT_STARTS,
  type DayName,
} from '@shared/constants';
import type { StaffMember } from '../../../main/ipc-types';

const TIME_SLOTS = TIME_SLOT_STARTS;
const HOUR_INPUT_STEP = SLOT_MINUTES / 60;

// Convert 24h time to 12h format for display
function formatTime12h(time24: string): string {
  const [hourStr, min] = time24.split(':');
  const hour = parseInt(hourStr, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${min} ${ampm}`;
}

export function StaffEditorTab() {
  const { staff, updateStaffMember, addStaffMember, removeStaffMember, dirty, setDirty, saveStaff } = useStaffStore();
  const { departments } = useDepartmentStore();
  const { showToast } = useUIStore();
  
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Available roles from departments + common roles
  const availableRoles = useMemo(() => {
    const roles = new Set(COMMON_ROLES);
    departments.forEach(d => roles.add(d.name.toLowerCase().replace(/\s+/g, '_')));
    return Array.from(roles).sort();
  }, [departments]);

  const filteredStaff = useMemo(() => {
    if (!searchTerm) return staff;
    const term = searchTerm.toLowerCase();
    return staff.filter(s => 
      s.name.toLowerCase().includes(term) ||
      s.roles.some(r => r.includes(term))
    );
  }, [staff, searchTerm]);

  const handleAddEmployee = () => {
    const newEmployee: StaffMember = {
      name: '',
      roles: ['front_desk'],
      targetHours: 10,
      maxHours: 15,
      year: 1,
      availability: Object.fromEntries(AVAILABILITY_COLUMNS.map(col => [col, true])),
      travelBuffers: createDefaultTravelBuffers(),
    };
    addStaffMember(newEmployee);
    setSelectedIndex(staff.length);
  };

  const handleExport = async () => {
    try {
      const csv = staffToCsv(staff);
      const result = await window.electronAPI.files.saveCsv({
        kind: 'staff',
        content: csv,
      });
      if (!result.canceled) {
        setDirty(false);
        showToast('Staff CSV exported successfully', 'success');
      }
    } catch (err) {
      console.error('Failed to export staff CSV:', err);
      showToast('Failed to export staff CSV', 'error');
    }
  };

  const handleBulkFillAvailability = (fill: boolean) => {
    if (selectedIndex === null) return;
    const newAvailability = Object.fromEntries(
      AVAILABILITY_COLUMNS.map(col => [col, fill])
    );
    updateStaffMember(selectedIndex, { availability: newAvailability });
  };

  const selectedEmployee = selectedIndex !== null ? staff[selectedIndex] : null;

  const updateTravelBuffer = (
    employeeIndex: number,
    day: DayName,
    key: 'beforeNextCommitment' | 'afterPreviousCommitment',
    value: boolean,
  ) => {
    const employee = staff[employeeIndex];
    updateStaffMember(employeeIndex, {
      travelBuffers: {
        ...employee.travelBuffers,
        [day]: {
          ...employee.travelBuffers[day],
          [key]: value,
        },
      },
    });
  };

  if (staff.length === 0) {
    return (
      <EmptyState
        icon={
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        }
        title="No Staff Data"
        description="Import a staff CSV from the Import tab or create employees manually."
        action={{
          label: 'Add First Employee',
          onClick: handleAddEmployee,
        }}
      />
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-100 mb-1">
            Staff Editor
          </h2>
          <p className="text-surface-400">
            {staff.length} employee{staff.length !== 1 ? 's' : ''} 
            {dirty && <span className="text-warning-400 ml-2">(unsaved changes)</span>}
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={handleAddEmployee} className="btn-secondary">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Employee
          </button>
          <button 
            onClick={async () => {
              try {
                await saveStaff();
                showToast('Staff data saved', 'success');
              } catch (err) {
                console.error('Failed to save staff:', err);
                showToast('Failed to save staff data', 'error');
              }
            }} 
            className="btn-primary"
            disabled={!dirty || staff.length === 0}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Save
          </button>
          <button onClick={handleExport} className="btn-secondary" disabled={staff.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        {/* Employee List */}
        <div className="lg:col-span-1 card p-0 overflow-hidden h-fit">
          <div className="p-4 border-b border-surface-700">
            <input
              type="text"
              placeholder="Search employees..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input"
              aria-label="Search employees"
            />
          </div>
          <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
            {filteredStaff.map((employee, _index) => {
              const actualIndex = staff.indexOf(employee);
              const hasNoRoles = employee.roles.length === 0;
              return (
                <button
                  key={actualIndex}
                  onClick={() => setSelectedIndex(actualIndex)}
                  className={`
                    w-full px-4 py-3 text-left border-b border-surface-800 last:border-0
                    hover:bg-surface-800 transition-colors
                    ${selectedIndex === actualIndex ? 'bg-surface-800 border-l-2 border-l-accent-500' : ''}
                    ${hasNoRoles ? 'bg-warning-500/10 border-l-2 border-l-warning-500' : ''}
                  `}
                >
                  <div className={`font-medium ${hasNoRoles ? 'text-warning-400' : 'text-surface-200'}`}>
                    {employee.name || <span className="text-surface-500 italic">Unnamed</span>}
                    {hasNoRoles && (
                      <svg className="w-4 h-4 inline ml-2 text-warning-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    )}
                  </div>
                  <div className={`text-sm mt-0.5 ${hasNoRoles ? 'text-warning-400' : 'text-surface-400'}`}>
                    {hasNoRoles ? 'No qualifications' : (
                      <>
                        {employee.roles.slice(0, 2).join(', ')}
                        {employee.roles.length > 2 && ` +${employee.roles.length - 2}`}
                      </>
                    )}
                  </div>
                  <div className="text-xs text-surface-500 mt-1">
                    Year {employee.year} · {employee.targetHours}h target
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Editor Panel */}
        <div className="lg:col-span-2 space-y-6">
          {selectedEmployee ? (
            <>
              {/* Basic Info */}
              <div className="card">
                <h3 className="font-semibold text-surface-200 mb-4">Basic Information</h3>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="label" htmlFor="emp-name">Name</label>
                    <input
                      id="emp-name"
                      type="text"
                      value={selectedEmployee.name}
                      onChange={(e) => updateStaffMember(selectedIndex!, { name: e.target.value })}
                      className="input"
                      placeholder="Employee name"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="emp-year">Academic Year</label>
                    <select
                      id="emp-year"
                      value={selectedEmployee.year}
                      onChange={(e) => updateStaffMember(selectedIndex!, { year: parseInt(e.target.value) })}
                      className="input"
                    >
                      {[1, 2, 3, 4, 5, 6].map(y => (
                        <option key={y} value={y}>Year {y}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="emp-target">Target Hours/Week</label>
                    <input
                      id="emp-target"
                      type="number"
                      min="0"
                      max="40"
                      step={HOUR_INPUT_STEP}
                      value={selectedEmployee.targetHours || ''}
                      onChange={(e) => updateStaffMember(selectedIndex!, { targetHours: parseFloat(e.target.value) || 0 })}
                      onBlur={(e) => {
                        if (e.target.value === '') {
                          updateStaffMember(selectedIndex!, { targetHours: 0 });
                        }
                      }}
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="emp-max">Max Hours/Week</label>
                    <input
                      id="emp-max"
                      type="number"
                      min="0"
                      max="40"
                      step={HOUR_INPUT_STEP}
                      value={selectedEmployee.maxHours || ''}
                      onChange={(e) => updateStaffMember(selectedIndex!, { maxHours: parseFloat(e.target.value) || 0 })}
                      onBlur={(e) => {
                        if (e.target.value === '') {
                          updateStaffMember(selectedIndex!, { maxHours: 0 });
                        }
                      }}
                      className="input"
                    />
                  </div>
                </div>
              </div>

              {/* Roles */}
              <div className="card">
                <h3 className="font-semibold text-surface-200 mb-4">Roles / Qualifications</h3>
                <div className="flex flex-wrap gap-2">
                  {availableRoles.map(role => {
                    const isSelected = selectedEmployee.roles.includes(role);
                    return (
                      <button
                        key={role}
                        onClick={() => {
                          const newRoles = isSelected
                            ? selectedEmployee.roles.filter(r => r !== role)
                            : [...selectedEmployee.roles, role];
                          updateStaffMember(selectedIndex!, { roles: newRoles });
                        }}
                        className={`
                          px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                          ${isSelected 
                            ? 'bg-accent-600 text-white' 
                            : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}
                        `}
                        aria-pressed={isSelected}
                      >
                        {role.replace(/_/g, ' ')}
                      </button>
                    );
                  })}
                </div>
                {selectedEmployee.roles.length === 0 && (
                  <p className="text-sm text-danger-400 mt-2">
                    At least one role is required
                  </p>
                )}
              </div>

              {/* Availability Grid */}
              <div className="card">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-surface-200">Weekly Availability</h3>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleBulkFillAvailability(true)}
                      className="btn-ghost text-xs"
                    >
                      Fill All
                    </button>
                    <button
                      onClick={() => handleBulkFillAvailability(false)}
                      className="btn-ghost text-xs"
                    >
                      Clear All
                    </button>
                  </div>
                </div>
                
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th className="text-left py-2 px-1 text-surface-400 font-medium">Time</th>
                        {DAY_NAMES.map(day => {
                          // Check if all slots for this day are available
                          const allAvailable = TIME_SLOTS.every(
                            time => selectedEmployee.availability[`${day}_${time}`]
                          );
                          return (
                            <th key={day} className="text-center py-2 px-1 w-12">
                              <button
                                onClick={() => {
                                  // Toggle all time slots for this day
                                  const newAvail = { ...selectedEmployee.availability };
                                  TIME_SLOTS.forEach(time => {
                                    newAvail[`${day}_${time}`] = !allAvailable;
                                  });
                                  updateStaffMember(selectedIndex!, { availability: newAvail });
                                }}
                                className="text-surface-400 font-medium hover:text-accent-400 transition-colors"
                                title={`Click to ${allAvailable ? 'clear' : 'fill'} all ${day} slots`}
                              >
                            {day}
                              </button>
                          </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {TIME_SLOTS.map(time => (
                        <tr key={time} className="border-t border-surface-800">
                          <td className="py-1 px-1 text-surface-400 whitespace-nowrap">{formatTime12h(time)}</td>
                          {DAY_NAMES.map(day => {
                            const col = `${day}_${time}`;
                            const isAvailable = selectedEmployee.availability[col];
                            return (
                              <td key={col} className="text-center py-1 px-1">
                                <button
                                  onClick={() => {
                                    const newAvail = { ...selectedEmployee.availability, [col]: !isAvailable };
                                    updateStaffMember(selectedIndex!, { availability: newAvail });
                                  }}
                                  className={`
                                    w-8 h-6 rounded transition-colors
                                    ${isAvailable 
                                      ? 'bg-accent-600 hover:bg-accent-500' 
                                      : 'bg-surface-700 hover:bg-surface-600'}
                                  `}
                                  aria-label={`${day} ${time}: ${isAvailable ? 'available' : 'unavailable'}`}
                                  aria-pressed={isAvailable}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-5 pt-4 border-t border-surface-800">
                  <h4 className="font-medium text-surface-300 mb-3">Travel Buffer Flags</h4>
                  <div className="grid gap-3">
                    {DAY_NAMES.map((day) => {
                      const travelBuffer = selectedEmployee.travelBuffers[day];
                      return (
                        <div
                          key={`${day}-travel-buffer`}
                          className="flex flex-col gap-2 rounded-lg border border-surface-800 bg-surface-900/50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <div className="font-medium text-surface-200">{day}</div>
                            <div className="text-xs text-surface-500">
                              Trim one {SLOT_MINUTES}-minute slot where availability meets another commitment.
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-4 text-sm text-surface-300">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={travelBuffer.afterPreviousCommitment}
                                onChange={(e) =>
                                  updateTravelBuffer(selectedIndex!, day, 'afterPreviousCommitment', e.target.checked)
                                }
                              />
                              Start {SLOT_MINUTES} min late
                            </label>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={travelBuffer.beforeNextCommitment}
                                onChange={(e) =>
                                  updateTravelBuffer(selectedIndex!, day, 'beforeNextCommitment', e.target.checked)
                                }
                              />
                              Leave {SLOT_MINUTES} min early
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Legend */}
                <div className="mt-4 pt-3 border-t border-surface-800 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-surface-400">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-3 rounded bg-accent-600"></span>
                    <span>Available</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-3 rounded bg-surface-700"></span>
                    <span>Not Available</span>
                  </div>
                  <div className="text-surface-500">
                    Each block = {SLOT_MINUTES} min · Click a day to toggle the full column
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-end">
                <button
                  onClick={async () => {
                    if (window.confirm(`Delete ${selectedEmployee.name || 'this employee'}?`)) {
                      removeStaffMember(selectedIndex!);
                      setSelectedIndex(null);
                      // Auto-save after deletion
                      try {
                        await saveStaff();
                        showToast('Employee deleted', 'info');
                      } catch (err) {
                        console.error('Failed to save after delete:', err);
                        showToast('Failed to save changes', 'error');
                      }
                    }
                  }}
                  className="btn-danger"
                >
                  Delete Employee
                </button>
              </div>
            </>
          ) : (
            <div className="card flex items-center justify-center h-64 text-surface-400">
              Select an employee from the list to edit
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
