# Web Absen HRP - Implementation Summary

## Overview
Updated Web Absen HRP to synchronize with HRP utama's employee_profiles collection and enhanced attendance history filtering.

---

## Changes Made

### 1. Data Synchronization - `use-user.tsx`

**Objective**: Make `employee_profiles` (from HRP utama) the source of truth for employee data.

**Changes**:
- Added `employeeId` and `employeeProfileFound` fields to `ExtendedUser` interface
- Refactored user data fetching to prioritize `employee_profiles/{uid}`:
  - Fetches `fullName`, `brandName`, `division`, `employeeId`, `employmentType`, `attendanceMethod` from `employee_profiles`
  - Supports field name variations: `namaLengkap`/`name`, `companyName`/`brand`, `divisionName`/`unit`, `nik`/`nomorIndukKaryawan`
  - Sets `employeeProfileFound` flag to track if profile exists
- Fallback to `users/{uid}` only for role/auth info
- Fallback to Firebase Auth display name if no name found

**Database Schema Expected**:
```
employee_profiles/{uid}
  ├── fullName / namaLengkap / name
  ├── brandName / companyName / brand
  ├── division / divisionName / unit
  ├── employeeId / nik / nomorIndukKaryawan
  ├── employmentType
  └── attendanceMethod (fingerprint | web_absen)
```

---

### 2. Gate Control - `absen/page.tsx` (Access Logic)

**Objective**: Control attendance access based on `attendanceMethod` from `employee_profiles`.

**Changes**:
- Updated `isAttendanceAllowed` to check `attendanceMethod === 'web_absen'`
- Updated `restrictedMessage` with three scenarios:
  1. `fingerprint`: "Akun Anda menggunakan absensi fingerprint. Web absen tidak tersedia untuk akun ini."
  2. `undefined/null`: "Metode absensi Anda belum diatur oleh HRD. Silakan hubungi HRD."
  3. Default fallback if neither

**Removed**:
- Old logic that restricted by `employmentType` (magang/training/karyawan)

---

### 3. User Profile Display - `absen/page.tsx` (Header)

**Improvements**:
- Display warning banner if `employeeProfileFound === false`:
  - Shows "Data Profil Tidak Ditemukan"
  - Instructs user to contact HRD
- Enhanced header to show:
  - Employee name (from `employee_profiles`)
  - Brand/Company name
  - Division (if available)
  - Employee ID / NIK (if available)
  - Attendance method badge (shows "web absen" or "fingerprint")

---

### 4. History Filtering - `absen/page.tsx` (Tab History)

**Objective**: Provide comprehensive filtering for attendance history.

**Added Filter State**:
```typescript
const [historyFilterMode, setHistoryFilterMode] = useState<'quick' | 'custom' | 'month'>('quick');
const [selectedQuickFilter, setSelectedQuickFilter] = useState<'today' | 'week' | 'month' | 'year'>('month');
const [customStartDate, setCustomStartDate] = useState<string>(/* 7 days ago */);
const [customEndDate, setCustomEndDate] = useState<string>(/* today */);
const [selectedMonth, setSelectedMonth] = useState<string>(/* current month */);
const [statusFilter, setStatusFilter] = useState<string>('all');
```

**Filter UI**:
1. **Mode Selector**: Quick | Tanggal (Custom) | Bulan (Month)
2. **Quick Filters**: Hari Ini | Minggu Ini | Bulan Ini | Tahun Ini
3. **Custom Range**: Date input (start & end dates)
4. **Month Picker**: HTML5 `<input type="month">`
5. **Status Filter**: Dropdown with options:
   - Semua Status
   - Hadir (ON_TIME)
   - Terlambat (LATE)
   - Pulang Awal (EARLY_LEAVE)
   - Normal

**Date Range Calculation**:
- Helper function `getDateRangeForFilter()` computes start/end dates based on selected filter
- Handles all 4 quick filters (today, week, month, year)
- Custom date range support
- Month picker converts to date range (1st to last day of month)

**Event Filtering**:
- `filteredHistoryEvents` useMemo filters events by:
  - Date range (inclusive of start and end dates)
  - Status (if not 'all')
- Client-side filtering (all events fetched, filtered in JavaScript)

---

### 5. History Summary - `absen/page.tsx`

**Added Summary Cards** displaying:
- **Hadir** (ON_TIME count) - green badge
- **Terlambat** (LATE count) - red badge
- **Pulang Awal** (EARLY_LEAVE count) - orange badge
- **Belum Tap Out** (days with IN but no OUT) - yellow badge

**Summary Calculation Logic**:
- Counts TAP IN events by status
- Calculates days with incomplete cycles (IN without OUT)
- Aggregates by selected date range and status

---

### 6. History Display - `absen/page.tsx`

**Enhanced Event Cards** now show:
- Date & day of week (EEEE, dd MMM yyyy format)
- Event type with emoji and time (📍 Tap Masuk HH:mm | 🚪 Tap Keluar HH:mm)
- Location/site name
- Status badge with context:
  - TEPAT WAKTU (green) for ON_TIME
  - TERLAMBAT (red) with minutes late
  - PULANG AWAL (orange) for EARLY_LEAVE
- OFFSITE flag (orange warning badge) if `flags.includes('OFFSITE')`

**Empty State**:
- Shows "Belum ada riwayat absensi pada periode ini." with icon
- Only when no events match selected filters

---

### 7. Firestore Rules - `firestore.rules`

**Added/Updated Rules**:

```firestore
match /employee_profiles/{uid} {
  allow read: if isSignedIn() && request.auth.uid == uid;
  allow read, write: if isStaff();
}
```

**Rules Ensure**:
- Users can only read their own `employee_profiles` document
- HRD/Manager/SuperAdmin can read & write all `employee_profiles`
- Existing `attendance_events` rules unchanged (user can read/create their own)

---

## Technical Notes

### Firestore Query Performance
- History query fetches all events for the user (no date range constraint in Firestore)
- Filtering done client-side in `filteredHistoryEvents` useMemo
- For large datasets (10k+ records), consider adding composite index and query-time date filtering:
  ```typescript
  where('tsClient', '>=', Timestamp.fromDate(filterStartDate)),
  where('tsClient', '<=', Timestamp.fromDate(filterEndDate)),
  ```
- Would require Firestore composite index creation

### Browser Compatibility
- Uses HTML5 `<input type="date">` and `<input type="month">` (IE 11+ support)
- Graceful fallback to text input if needed

### Data Consistency
- On login, user data fetched from `employee_profiles` once (during useUser hook)
- If HRP utama updates `attendanceMethod`, user needs to re-login to see changes
- For real-time updates, could wrap user data in `onSnapshot` listener (requires refactor)

---

## Testing Checklist

- [ ] Login with user having `attendanceMethod = 'web_absen'` → Tap buttons visible
- [ ] Login with user having `attendanceMethod = 'fingerprint'` → Restrict message shown
- [ ] Login with user missing `attendanceMethod` → "Not set by HRD" message shown
- [ ] Verify employee profile data displayed correctly in header:
  - [ ] Name from `fullName` field
  - [ ] Brand from `brandName` field
  - [ ] Division (if present)
  - [ ] Employee ID (if present)
- [ ] History filters:
  - [ ] Quick filters (Hari Ini, Minggu Ini, Bulan Ini, Tahun Ini) work
  - [ ] Custom date range picker works
  - [ ] Month picker works
  - [ ] Status dropdown filters correctly
- [ ] History summary cards show correct counts
- [ ] Empty state shown when no records in period
- [ ] OFFSITE flag displayed for events outside radius
- [ ] Tap In/Out flow unchanged (photo, GPS, validation still work)
- [ ] Firebase rules allow user to read their `employee_profiles`

---

## Known Limitations & Future Improvements

1. **Real-time Profile Updates**: User data cached on login; re-login required for HRP changes
2. **Large Dataset Performance**: History query unoptimized for 100k+ attendance records
3. **Month Picker**: HTML5 month input may not work on older browsers
4. **No Data Export**: History cannot be exported to CSV/PDF
5. **Limited Anomaly Detection**: OFFSITE flag only marks out-of-radius; no other anomaly handling

---

## Files Modified

1. `src/firebase/auth/use-user.tsx` - Employee data fetching logic
2. `src/app/absen/page.tsx` - Gate control, header display, history filtering
3. `firestore.rules` - Access control for `employee_profiles`

## Files NOT Changed (Preserved)

- Photo capture flow (`components/camera-capture.tsx`)
- GPS validation logic
- Attendance event structure
- Auth login flow
- HRP utama integration (read-only)
