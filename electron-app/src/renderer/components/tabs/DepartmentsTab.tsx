/**
 * Departments Tab Component
 * Table editor for department hour budgets
 */

import { useState } from 'react';
import { useDepartmentStore, useUIStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { departmentsToCsv } from '../../utils/csvValidators';
import { SLOT_MINUTES } from '@shared/constants';
import type { Department } from '../../../main/ipc-types';

const HOUR_INPUT_STEP = SLOT_MINUTES / 60;

export function DepartmentsTab() {
  const { departments, updateDepartment, addDepartment, removeDepartment, reorderDepartments, dirty, setDirty, saveDepartments } = useDepartmentStore();
  const { showToast } = useUIStore();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragOverBottom, setDragOverBottom] = useState(false);

  const handleAddDepartment = () => {
    const newDept: Department = {
      name: '',
      targetHours: 20,
      maxHours: 30,
    };
    addDepartment(newDept);
    // Set editing index to the new department (will be at end of array)
    setEditingIndex(departments.length);
  };

  const handleExport = async () => {
    try {
      const csv = departmentsToCsv(departments);
      const result = await window.electronAPI.files.saveCsv({
        kind: 'dept',
        content: csv,
      });
      if (!result.canceled) {
        setDirty(false);
        showToast('Department CSV exported successfully', 'success');
      }
    } catch (err) {
      console.error('Failed to export department CSV:', err);
      showToast('Failed to export department CSV', 'error');
    }
  };

  const getTotalHours = () => {
    return {
      target: departments.reduce((sum, d) => sum + d.targetHours, 0),
      max: departments.reduce((sum, d) => sum + d.maxHours, 0),
    };
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
    
    // Find the parent row to use as drag image (so entire row shows, not just the handle)
    const row = (e.currentTarget as HTMLElement).closest('tr');
    if (row) {
      e.dataTransfer.setDragImage(row, 50, 20);
    }
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedIndex === null || draggedIndex === index) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isBottomHalf = e.clientY > rect.top + rect.height / 2;
    const isLastItem = index === departments.length - 1;
    
    setDragOverIndex(index);
    setDragOverBottom(isBottomHalf && isLastItem);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
    setDragOverBottom(false);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === toIndex) return;
    
    // If dropping on bottom half of last item, move to end
    const targetIndex = dragOverBottom ? departments.length - 1 : toIndex;
    reorderDepartments(draggedIndex, targetIndex);
    
    setDraggedIndex(null);
    setDragOverIndex(null);
    setDragOverBottom(false);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    setDragOverBottom(false);
  };

  if (departments.length === 0) {
    return (
      <EmptyState
        icon={
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        }
        title="No Department Data"
        description="Import a department CSV from the Import tab or create departments manually."
        action={{
          label: 'Add First Department',
          onClick: handleAddDepartment,
        }}
      />
    );
  }

  const totals = getTotalHours();

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-100 mb-1">
            Department Budgets
          </h2>
          <p className="text-surface-400">
            {departments.length} department{departments.length !== 1 ? 's' : ''} 
            {dirty && <span className="text-warning-400 ml-2">(unsaved changes)</span>}
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={handleAddDepartment} className="btn-secondary">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Department
          </button>
          <button 
            onClick={async () => {
              try {
                await saveDepartments();
                showToast('Department data saved', 'success');
              } catch (err) {
                console.error('Failed to save departments:', err);
                showToast('Failed to save department data', 'error');
              }
            }} 
            className="btn-primary"
            disabled={!dirty || departments.length === 0}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Save
          </button>
          <button onClick={handleExport} className="btn-secondary" disabled={departments.length === 0}>
            Export CSV
          </button>
        </div>
      </div>

      {/* Summary Card */}
      <div className="card bg-surface-800/50">
        <div className="grid grid-cols-3 gap-6 text-center">
          <div>
            <div className="text-3xl font-display font-semibold text-surface-100">
              {departments.length}
            </div>
            <div className="text-sm text-surface-400">Departments</div>
          </div>
          <div>
            <div className="text-3xl font-display font-semibold text-accent-400">
              {totals.target}h
            </div>
            <div className="text-sm text-surface-400">Total Target Hours</div>
          </div>
          <div>
            <div className="text-3xl font-display font-semibold text-surface-300">
              {totals.max}h
            </div>
            <div className="text-sm text-surface-400">Total Max Hours</div>
          </div>
        </div>
      </div>

      {/* Department Table */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full">
          <thead className="bg-surface-800">
            <tr>
              <th className="w-10"></th>
              <th className="text-left py-3 px-4 text-sm font-medium text-surface-300">
                Department
              </th>
              <th className="text-center py-3 px-4 text-sm font-medium text-surface-300">
                Target Hours
              </th>
              <th className="text-center py-3 px-4 text-sm font-medium text-surface-300">
                Max Hours
              </th>
              <th className="text-center py-3 px-4 text-sm font-medium text-surface-300 w-24">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {departments.map((dept, index) => {
              const isEditing = editingIndex === index;
              const hasError = dept.targetHours > dept.maxHours;
              const isDragging = draggedIndex === index;
              const isDragOver = dragOverIndex === index;
              const isLastItem = index === departments.length - 1;
              const showTopBorder = isDragOver && !dragOverBottom;
              const showBottomBorder = isDragOver && dragOverBottom && isLastItem;

              return (
                <tr 
                  key={`dept-${index}`} 
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  className={`
                    border-t border-surface-700 transition-all
                    ${hasError ? 'bg-danger-500/5' : 'hover:bg-surface-800/50'}
                    ${isDragging ? 'opacity-50' : ''}
                    ${showTopBorder ? 'border-t-2 border-t-accent-500' : ''}
                    ${showBottomBorder ? 'border-b-2 border-b-accent-500' : ''}
                  `}
                >
                  {/* Drag Handle */}
                  <td className="py-3 pl-2 pr-0">
                    <div 
                      draggable
                      onDragStart={(e) => handleDragStart(e, index)}
                      className="cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 transition-colors flex items-center justify-center"
                      title="Drag to reorder"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                        <circle cx="6" cy="5" r="1.5" />
                        <circle cx="14" cy="5" r="1.5" />
                        <circle cx="6" cy="10" r="1.5" />
                        <circle cx="14" cy="10" r="1.5" />
                        <circle cx="6" cy="15" r="1.5" />
                        <circle cx="14" cy="15" r="1.5" />
                      </svg>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    {isEditing ? (
                      <input
                        type="text"
                        value={dept.name}
                        onChange={(e) => updateDepartment(index, { name: e.target.value })}
                        onBlur={() => setEditingIndex(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setEditingIndex(null);
                          }
                        }}
                        className="input py-1"
                        placeholder="Department name"
                        autoFocus
                      />
                    ) : (
                      <button
                        onClick={() => setEditingIndex(index)}
                        className="text-left hover:text-accent-400 transition-colors"
                      >
                        {dept.name || <span className="text-surface-500 italic">Unnamed</span>}
                      </button>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step={HOUR_INPUT_STEP}
                      value={dept.targetHours || ''}
                      onChange={(e) => updateDepartment(index, { targetHours: parseFloat(e.target.value) || 0 })}
                      onBlur={(e) => {
                        if (e.target.value === '') {
                          updateDepartment(index, { targetHours: 0 });
                        }
                      }}
                      className={`input py-1 text-center w-24 mx-auto ${hasError ? 'input-error' : ''}`}
                    />
                  </td>
                  <td className="py-3 px-4 text-center">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step={HOUR_INPUT_STEP}
                      value={dept.maxHours || ''}
                      onChange={(e) => updateDepartment(index, { maxHours: parseFloat(e.target.value) || 0 })}
                      onBlur={(e) => {
                        if (e.target.value === '') {
                          updateDepartment(index, { maxHours: 0 });
                        }
                      }}
                      className={`input py-1 text-center w-24 mx-auto ${hasError ? 'input-error' : ''}`}
                    />
                  </td>
                  <td className="py-3 px-4 text-center">
                    <button
                      onClick={async () => {
                        if (window.confirm(`Delete ${dept.name || 'this department'}?`)) {
                          removeDepartment(index);
                          // Auto-save after deletion
                          try {
                            await saveDepartments();
                            showToast('Department deleted', 'info');
                          } catch (err) {
                            console.error('Failed to save after delete:', err);
                            showToast('Failed to save changes', 'error');
                          }
                        }
                      }}
                      className="btn-ghost text-danger-400 hover:text-danger-300 p-1 mx-auto"
                      aria-label={`Delete ${dept.name}`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-surface-800/50">
            <tr>
              <td></td>
              <td className="py-3 px-4 font-medium text-surface-300">
                Total
              </td>
              <td className="py-3 px-4 text-center font-medium text-accent-400">
                {totals.target}h
              </td>
              <td className="py-3 px-4 text-center font-medium text-surface-300">
                {totals.max}h
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Validation Messages */}
      {departments.some(d => d.targetHours > d.maxHours) && (
        <div className="bg-danger-500/10 border border-danger-500/30 rounded-lg p-4 flex items-start gap-3">
          <svg className="w-5 h-5 text-danger-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="font-medium text-danger-400">Validation Error</p>
            <p className="text-sm text-danger-300 mt-1">
              Some departments have target hours exceeding max hours. Please fix before generating a schedule.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
