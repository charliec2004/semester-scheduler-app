/**
 * CSV Validation and Parsing Utilities
 * Validates staff and department CSVs against expected schemas
 */

import Papa from 'papaparse';
import type { StaffMember, Department, ValidationError, ValidationResult } from '../../main/ipc-types';
import {
  AVAILABILITY_COLUMNS,
  createDefaultTravelBuffers,
  DAY_NAMES,
  isSlotAlignedHours,
  LEGACY_AVAILABILITY_COLUMNS,
  normalizeAvailabilityMap,
  TRAVEL_BUFFER_AFTER_COLUMNS,
  TRAVEL_BUFFER_BEFORE_COLUMNS,
  TRAVEL_BUFFER_COLUMNS,
} from '../../shared/constants';

export { AVAILABILITY_COLUMNS } from '../../shared/constants';

const REQUIRED_STAFF_COLUMNS = ['name', 'roles', 'target_hours', 'max_hours', 'year'];
const REQUIRED_DEPT_COLUMNS = ['department', 'target_hours', 'max_hours'];

function hasAllHeaders(headers: string[], required: string[]): boolean {
  return required.every(header => headers.includes(header.toLowerCase()));
}

function validateSlotAlignedHours(
  value: number,
  rowNum: number,
  column: string,
  errors: ValidationError[],
): void {
  if (!isNaN(value) && !isSlotAlignedHours(value)) {
    errors.push({
      row: rowNum,
      column,
      message: `${column} must align to 10-minute increments (for example 1, 1.5, 1.6667, 2)`,
      severity: 'error',
    });
  }
}

// ---------------------------------------------------------------------------
// Staff CSV Validation
// ---------------------------------------------------------------------------

export function validateStaffCsv(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      errors.push({
        row: err.row,
        message: err.message,
        severity: 'error',
      });
    }
  }

  const headers = parsed.meta.fields || [];

  // Check required columns
  for (const col of REQUIRED_STAFF_COLUMNS) {
    if (!headers.includes(col)) {
      errors.push({
        column: col,
        message: `Missing required column: ${col}`,
        severity: 'error',
      });
    }
  }

  // Check availability columns
  const hasCurrentAvailabilityGrid = hasAllHeaders(headers, AVAILABILITY_COLUMNS);
  const hasLegacyAvailabilityGrid = hasAllHeaders(headers, LEGACY_AVAILABILITY_COLUMNS);
  if (!hasCurrentAvailabilityGrid) {
    if (hasLegacyAvailabilityGrid) {
      warnings.push({
        message: 'Legacy 30-minute availability columns detected. They will be expanded to the 10-minute grid on import.',
        severity: 'warning',
      });
    } else {
      errors.push({
        message: 'Missing required availability columns. Provide either the full 10-minute grid or the legacy 30-minute grid.',
        severity: 'error',
      });
    }
  }

  // Validate each row
  const names = new Set<string>();
  let hasFrontDesk = false;

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const rowNum = i + 2; // Account for header row

    // Name validation
    const name = row.name?.trim();
    if (!name) {
      errors.push({
        row: rowNum,
        column: 'name',
        message: 'Name is required',
        severity: 'error',
      });
    } else if (names.has(name.toLowerCase())) {
      errors.push({
        row: rowNum,
        column: 'name',
        message: `Duplicate name: ${name}`,
        severity: 'error',
      });
    } else {
      names.add(name.toLowerCase());
    }

    // Roles validation
    const roles = row.roles?.trim();
    if (!roles) {
      errors.push({
        row: rowNum,
        column: 'roles',
        message: 'At least one role is required',
        severity: 'error',
      });
    } else {
      const roleList = roles.split(/[;,]/).map(r => r.trim().toLowerCase());
      if (roleList.includes('front_desk')) {
        hasFrontDesk = true;
      }
    }

    // Hours validation
    const targetHours = parseFloat(row.target_hours);
    const maxHours = parseFloat(row.max_hours);

    if (isNaN(targetHours) || targetHours < 0) {
      errors.push({
        row: rowNum,
        column: 'target_hours',
        message: 'target_hours must be a non-negative number',
        severity: 'error',
      });
    }

    if (isNaN(maxHours) || maxHours < 0) {
      errors.push({
        row: rowNum,
        column: 'max_hours',
        message: 'max_hours must be a non-negative number',
        severity: 'error',
      });
    }

    if (!isNaN(targetHours) && !isNaN(maxHours) && targetHours > maxHours) {
      errors.push({
        row: rowNum,
        message: 'target_hours cannot exceed max_hours',
        severity: 'error',
      });
    }

    validateSlotAlignedHours(targetHours, rowNum, 'target_hours', errors);
    validateSlotAlignedHours(maxHours, rowNum, 'max_hours', errors);

    // Year validation
    const year = parseInt(row.year);
    if (isNaN(year) || year < 1 || year > 6) {
      warnings.push({
        row: rowNum,
        column: 'year',
        message: 'year should be 1-6 (academic year)',
        severity: 'warning',
      });
    }

    // Availability validation
    for (const col of AVAILABILITY_COLUMNS) {
      const val = row[col.toLowerCase()];
      if (val !== undefined && val !== '' && val !== '0' && val !== '1') {
        warnings.push({
          row: rowNum,
          column: col,
          message: `Availability should be 0 or 1, got: ${val}`,
          severity: 'warning',
        });
      }
    }

    for (const col of TRAVEL_BUFFER_COLUMNS) {
      const val = row[col.toLowerCase()];
      if (val !== undefined && val !== '' && val !== '0' && val !== '1') {
        warnings.push({
          row: rowNum,
          column: col,
          message: `Travel buffer flag should be 0 or 1, got: ${val}`,
          severity: 'warning',
        });
      }
    }
  }

  // Check for at least one front_desk qualified employee
  if (!hasFrontDesk && parsed.data.length > 0) {
    errors.push({
      message: 'At least one employee must have front_desk role',
      severity: 'error',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function parseStaffCsv(content: string): StaffMember[] {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  return parsed.data.map(row => {
    const rawAvailability: Record<string, boolean> = {};
    for (const col of AVAILABILITY_COLUMNS) {
      if (row[col.toLowerCase()] !== undefined) {
        rawAvailability[col] = row[col.toLowerCase()] === '1';
      }
    }
    for (const col of LEGACY_AVAILABILITY_COLUMNS) {
      if (row[col.toLowerCase()] !== undefined) {
        rawAvailability[col] = row[col.toLowerCase()] === '1';
      }
    }
    const travelBuffers = createDefaultTravelBuffers();
    for (const day of DAY_NAMES) {
      travelBuffers[day].beforeNextCommitment = row[TRAVEL_BUFFER_BEFORE_COLUMNS[day].toLowerCase()] === '1';
      travelBuffers[day].afterPreviousCommitment = row[TRAVEL_BUFFER_AFTER_COLUMNS[day].toLowerCase()] === '1';
    }

    return {
      name: row.name?.trim() || '',
      roles: (row.roles || '').split(/[;,]/).map(r => r.trim().toLowerCase()).filter(Boolean),
      targetHours: parseFloat(row.target_hours) || 0,
      maxHours: parseFloat(row.max_hours) || 0,
      year: parseInt(row.year) || 1,
      availability: normalizeAvailabilityMap(rawAvailability),
      travelBuffers,
    };
  });
}

// ---------------------------------------------------------------------------
// Department CSV Validation
// ---------------------------------------------------------------------------

export function validateDepartmentCsv(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      errors.push({
        row: err.row,
        message: err.message,
        severity: 'error',
      });
    }
  }

  const headers = parsed.meta.fields || [];

  // Check required columns
  for (const col of REQUIRED_DEPT_COLUMNS) {
    if (!headers.includes(col)) {
      errors.push({
        column: col,
        message: `Missing required column: ${col}`,
        severity: 'error',
      });
    }
  }

  // Validate each row
  const deptNames = new Set<string>();

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const rowNum = i + 2;

    // Department name validation
    const deptName = row.department?.trim();
    if (!deptName) {
      errors.push({
        row: rowNum,
        column: 'department',
        message: 'Department name is required',
        severity: 'error',
      });
    } else if (deptNames.has(deptName.toLowerCase())) {
      errors.push({
        row: rowNum,
        column: 'department',
        message: `Duplicate department: ${deptName}`,
        severity: 'error',
      });
    } else {
      deptNames.add(deptName.toLowerCase());
    }

    // Hours validation
    const targetHours = parseFloat(row.target_hours);
    const maxHours = parseFloat(row.max_hours);

    if (isNaN(targetHours) || targetHours < 0) {
      errors.push({
        row: rowNum,
        column: 'target_hours',
        message: 'target_hours must be a non-negative number',
        severity: 'error',
      });
    }

    if (isNaN(maxHours) || maxHours < 0) {
      errors.push({
        row: rowNum,
        column: 'max_hours',
        message: 'max_hours must be a non-negative number',
        severity: 'error',
      });
    }

    if (!isNaN(targetHours) && !isNaN(maxHours) && targetHours > maxHours) {
      errors.push({
        row: rowNum,
        message: 'target_hours cannot exceed max_hours',
        severity: 'error',
      });
    }

    validateSlotAlignedHours(targetHours, rowNum, 'target_hours', errors);
    validateSlotAlignedHours(maxHours, rowNum, 'max_hours', errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function parseDepartmentCsv(content: string): Department[] {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  return parsed.data.map(row => ({
    name: row.department?.trim() || '',
    targetHours: parseFloat(row.target_hours) || 0,
    maxHours: parseFloat(row.max_hours) || 0,
  }));
}

// ---------------------------------------------------------------------------
// CSV Export Utilities
// ---------------------------------------------------------------------------

export function staffToCsv(staff: StaffMember[]): string {
  const headers = [...REQUIRED_STAFF_COLUMNS, ...TRAVEL_BUFFER_COLUMNS, ...AVAILABILITY_COLUMNS];
  
  const rows = staff.map(member => {
    const row: Record<string, string> = {
      name: member.name,
      roles: member.roles.join(';'),
      target_hours: member.targetHours.toString(),
      max_hours: member.maxHours.toString(),
      year: member.year.toString(),
    };

    for (const day of DAY_NAMES) {
      row[TRAVEL_BUFFER_BEFORE_COLUMNS[day]] = member.travelBuffers?.[day]?.beforeNextCommitment ? '1' : '0';
      row[TRAVEL_BUFFER_AFTER_COLUMNS[day]] = member.travelBuffers?.[day]?.afterPreviousCommitment ? '1' : '0';
    }
    
    for (const col of AVAILABILITY_COLUMNS) {
      row[col] = member.availability[col] ? '1' : '0';
    }
    
    return row;
  });

  return Papa.unparse(rows, { columns: headers });
}

export function departmentsToCsv(departments: Department[]): string {
  const rows = departments.map(dept => ({
    department: dept.name,
    target_hours: dept.targetHours.toString(),
    max_hours: dept.maxHours.toString(),
  }));

  return Papa.unparse(rows);
}
