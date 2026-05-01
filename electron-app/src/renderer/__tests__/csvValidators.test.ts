/**
 * CSV Validator Tests
 * Unit tests for staff and department CSV validation
 */

import { describe, it, expect } from 'vitest';
import {
  validateStaffCsv,
  validateDepartmentCsv,
  parseStaffCsv,
  parseDepartmentCsv,
  staffToCsv,
  departmentsToCsv,
  AVAILABILITY_COLUMNS,
} from '../utils/csvValidators';
import { createDefaultTravelBuffers, LEGACY_AVAILABILITY_COLUMNS } from '../../shared/constants';

describe('Staff CSV Validation', () => {
  const validStaffCsv = `name,roles,target_hours,max_hours,year,${AVAILABILITY_COLUMNS.join(',')}
Alice,front_desk;marketing,10,15,2,${AVAILABILITY_COLUMNS.map(() => '1').join(',')}
Bob,front_desk,8,12,1,${AVAILABILITY_COLUMNS.map(() => '0').join(',')}`;

  it('validates correct staff CSV', () => {
    const result = validateStaffCsv(validStaffCsv);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects missing required columns', () => {
    const csv = `name,target_hours
Alice,10`;
    const result = validateStaffCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.column === 'roles')).toBe(true);
    expect(result.errors.some(e => e.column === 'max_hours')).toBe(true);
  });

  it('detects duplicate names', () => {
    const csv = `name,roles,target_hours,max_hours,year,${AVAILABILITY_COLUMNS.join(',')}
Alice,front_desk,10,15,2,${AVAILABILITY_COLUMNS.map(() => '1').join(',')}
Alice,marketing,8,12,1,${AVAILABILITY_COLUMNS.map(() => '0').join(',')}`;
    const result = validateStaffCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Duplicate'))).toBe(true);
  });

  it('detects target > max hours', () => {
    const csv = `name,roles,target_hours,max_hours,year,${AVAILABILITY_COLUMNS.join(',')}
Alice,front_desk,20,10,2,${AVAILABILITY_COLUMNS.map(() => '1').join(',')}`;
    const result = validateStaffCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('cannot exceed'))).toBe(true);
  });

  it('requires at least one front_desk role', () => {
    const csv = `name,roles,target_hours,max_hours,year,${AVAILABILITY_COLUMNS.join(',')}
Alice,marketing,10,15,2,${AVAILABILITY_COLUMNS.map(() => '1').join(',')}`;
    const result = validateStaffCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('front_desk'))).toBe(true);
  });

  it('parses staff CSV correctly', () => {
    const staff = parseStaffCsv(validStaffCsv);
    expect(staff).toHaveLength(2);
    expect(staff[0].name).toBe('Alice');
    expect(staff[0].roles).toContain('front_desk');
    expect(staff[0].roles).toContain('marketing');
    expect(staff[0].targetHours).toBe(10);
    expect(staff[0].maxHours).toBe(15);
    expect(staff[0].year).toBe(2);
    expect(staff[0].travelBuffers.Mon.beforeNextCommitment).toBe(false);
    expect(staff[0].travelBuffers.Mon.afterPreviousCommitment).toBe(false);
  });

  it('accepts legacy 30-minute availability grids and expands them', () => {
    const legacyCsv = `name,roles,target_hours,max_hours,year,${LEGACY_AVAILABILITY_COLUMNS.join(',')}
Alice,front_desk,10,15,2,${LEGACY_AVAILABILITY_COLUMNS.map((col) => col.endsWith('08:00') ? '1' : '0').join(',')}`;

    const validation = validateStaffCsv(legacyCsv);
    expect(validation.valid).toBe(true);
    expect(validation.warnings.some(w => w.message.includes('Legacy 30-minute'))).toBe(true);

    const [staff] = parseStaffCsv(legacyCsv);
    expect(staff.availability['Mon_08:00']).toBe(true);
    expect(staff.availability['Mon_08:10']).toBe(true);
    expect(staff.availability['Mon_08:20']).toBe(true);
    expect(staff.availability['Mon_08:30']).toBe(false);
  });

  it('rejects partial availability grids that cannot be migrated safely', () => {
    const partialCsv = `name,roles,target_hours,max_hours,year,Mon_08:00
Alice,front_desk,10,15,2,1`;
    const validation = validateStaffCsv(partialCsv);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some(e => e.message.includes('full 10-minute grid'))).toBe(true);
  });
});

describe('Department CSV Validation', () => {
  const validDeptCsv = `department,target_hours,max_hours
Marketing,20,30
Events,15,25`;

  it('validates correct department CSV', () => {
    const result = validateDepartmentCsv(validDeptCsv);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects missing required columns', () => {
    const csv = `department,target_hours
Marketing,20`;
    const result = validateDepartmentCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.column === 'max_hours')).toBe(true);
  });

  it('detects duplicate departments', () => {
    const csv = `department,target_hours,max_hours
Marketing,20,30
Marketing,15,25`;
    const result = validateDepartmentCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('Duplicate'))).toBe(true);
  });

  it('detects target > max hours', () => {
    const csv = `department,target_hours,max_hours
Marketing,40,30`;
    const result = validateDepartmentCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('cannot exceed'))).toBe(true);
  });

  it('parses department CSV correctly', () => {
    const depts = parseDepartmentCsv(validDeptCsv);
    expect(depts).toHaveLength(2);
    expect(depts[0].name).toBe('Marketing');
    expect(depts[0].targetHours).toBe(20);
    expect(depts[0].maxHours).toBe(30);
  });

  it('rejects department hour values that do not align to 10-minute increments', () => {
    const csv = `department,target_hours,max_hours
Marketing,12.25,15`;
    const result = validateDepartmentCsv(csv);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('10-minute increments'))).toBe(true);
  });
});

describe('CSV Export', () => {
  it('exports staff to CSV format', () => {
    const staff = [{
      name: 'Test',
      roles: ['front_desk', 'marketing'],
      targetHours: 10,
      maxHours: 15,
      year: 2,
      availability: Object.fromEntries(AVAILABILITY_COLUMNS.map(col => [col, true])),
      travelBuffers: createDefaultTravelBuffers(),
    }];
    
    const csv = staffToCsv(staff);
    expect(csv).toContain('name');
    expect(csv).toContain('Test');
    expect(csv).toContain('front_desk;marketing');
    expect(csv).toContain('10');
    expect(csv).toContain('15');
  });

  it('exports departments to CSV format', () => {
    const depts = [
      { name: 'Marketing', targetHours: 20, maxHours: 30 },
      { name: 'Events', targetHours: 15, maxHours: 25 },
    ];
    
    const csv = departmentsToCsv(depts);
    expect(csv).toContain('department');
    expect(csv).toContain('Marketing');
    expect(csv).toContain('Events');
    expect(csv).toContain('20');
    expect(csv).toContain('30');
  });
});
