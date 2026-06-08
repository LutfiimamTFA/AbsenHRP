# Web Absen HRP - Data Mapping Fix

## Overview
Fixed employee data mapping to ensure correct brand and employee ID fields are displayed from `employee_profiles` collection. Removed dependency on old data sources and eliminated NIK/KTP as employee ID fallback.

---

## Issues Fixed

### 1. Brand Mapping Issue ✅
**Problem**: Brand displayed was from old data sources, not the official brand from HRP utama.

**Solution**:
- Removed reliance on `userData?.brandName` as primary source
- Brand now exclusively pulled from `employee_profiles`
- Expanded field variation support: `brandName` > `companyName` > `company` > `unitName` > `brand`
- Only falls back to `userData` if `employee_profiles` completely empty

**Code**:
```typescript
// BEFORE: Could use old brand data
let brandName = userData?.brandName;

// AFTER: Exclusive to employee_profiles, strict fallback only
let brandName = employeeProfileData?.brandName || 
                employeeProfileData?.companyName ||
                employeeProfileData?.company || 
                employeeProfileData?.unitName || 
                employeeProfileData?.brand;
```

---

### 2. Employee ID Mapping Issue ✅
**Problem**: ID displayed was NIK/KTP instead of Nomor Induk Karyawan.

**Solution**:
- Removed `nik` from employeeId fallback chain
- Only uses employment/personnel ID fields: `employeeId`, `employeeNumber`, `nomorIndukKaryawan`, `nomorInduk`, `nip`
- Shows "ID belum diatur" instead of showing KTP number
- Clear comment in code: "Jangan gunakan NIK, KTP, nomorKtp, atau identityNumber"

**Code**:
```typescript
// BEFORE: Could fallback to NIK
let employeeId = employeeProfileData?.employeeId || employeeProfileData?.nik || ...;

// AFTER: NEVER uses NIK/KTP, only employment ID fields
let employeeId = employeeProfileData?.employeeId || 
                 employeeProfileData?.employeeNumber ||
                 employeeProfileData?.nomorIndukKaryawan || 
                 employeeProfileData?.nomorInduk || 
                 employeeProfileData?.nip;
```

---

## Field Mapping Priority

### Brand Mapping
**Priority Order** (use first found):
1. `brandName` — Official brand field
2. `companyName` — Company name variation
3. `company` — Another company field variation
4. `unitName` — Organizational unit
5. `brand` — Generic brand field

**Fallback Chain**:
- Employee_profiles brand found → Use it (priority)
- Employee_profiles brand empty → Try to fetch from brands/{brandId} using userData
- All empty → Default to "Brand belum diatur"

---

### Employee ID Mapping
**Priority Order** (use first found):
1. `employeeId` — Official employee ID field
2. `employeeNumber` — Employee number field
3. `nomorIndukKaryawan` — Indonesian: Employee Registration Number
4. `nomorInduk` — Indonesian: Registration Number (short)
5. `nip` — Indonesian: PNS Number

**EXCLUDED Fields** (NEVER used):
- ❌ `nik` — National Identity Number
- ❌ `nomorKtp` — KTP/ID Card Number
- ❌ `ktpNumber` — KTP Number variation
- ❌ `identityNumber` — Identity Number
- ❌ `noIdentitas` — Identity Number (Indonesian)

**Display**:
- If employeeId found → Show it with label "Nomor Induk Karyawan"
- If employeeId empty → Show "ID belum diatur"
- NEVER show KTP/NIK even if employeeId empty

---

### Division Mapping
**Priority Order**:
1. `division` — Standard field
2. `divisionName` — Named field
3. `divisi` — Indonesian variation

---

### Name Mapping
**Priority Order**:
1. `fullName` — Full name
2. `namaLengkap` — Indonesian: Full name
3. `name` — Simple name field

---

## Debug Logging

Added comprehensive console logs for development debugging:

```typescript
// Log 1: Initial login UID
console.log('[EMPLOYEE SYNC] UID Login:', firebaseUser.uid);

// Log 2: Profile found/not found
console.log('[EMPLOYEE SYNC] Profile found:', {
  uid: firebaseUser.uid,
  profileKeys: Object.keys(employeeProfileData)
});

// Log 3: Field mapping details
console.log('[EMPLOYEE SYNC] Field mapping:', {
  brandField: 'which field was used for brand',
  brandValue: 'the actual brand value',
  employeeIdField: 'which field was used for employeeId',
  employeeIdValue: 'the actual employee ID value',
  divisionField: 'which field was used for division',
  divisionValue: 'the actual division value'
});

// Log 4: Fallback brand from brands collection
console.log('[EMPLOYEE SYNC] Brand fetched from brands collection (fallback):', brandName);

// Log 5: Default brand fallback
console.log('[EMPLOYEE SYNC] Brand fallback to userData or default:', brandName);
```

**To Disable in Production**: Search for `[EMPLOYEE SYNC]` console logs and either:
1. Remove the console.log statements
2. Wrap in environment check: `if (process.env.NODE_ENV === 'development')`

---

## Header Display Updates

Enhanced header to show clear labels and proper employee ID:

### Before
```
Nama Lengkap
BRAND NAME
Division Name (if exists)
ID: 123456 (could be NIK)
```

### After
```
Nama Lengkap
BRAND NAME / UNIT NAME
📍 Division Name (if exists)
🆔 Nomor Induk Karyawan (shows "ID belum diatur" if empty)
```

**Key Changes**:
- Clear label with brand name (official from HRP)
- Division shown with emoji for clarity
- Employee ID shown with emoji
- "ID belum diatur" when no employee ID found (not NIK)
- Proper spacing and organization

---

## Firestore Rules (No Changes)

Existing rules already correct:
```firestore
match /employee_profiles/{uid} {
  allow read: if isSignedIn() && request.auth.uid == uid;
  allow read, write: if isStaff();
}
```

---

## Data Flow Diagram

```
User Login (Firebase Auth)
    ↓
useUser() Hook
    ↓
Fetch employee_profiles/{uid}
    ↓
    ├─ Brand: brandName → companyName → company → unitName → brand
    │    ↓ (if not found)
    │    └─ Fallback: brands/{brandId} → userData.brandName → "Brand belum diatur"
    │
    ├─ EmployeeId: employeeId → employeeNumber → nomorIndukKaryawan → nomorInduk → nip
    │    ↓ (if not found)
    │    └─ Display: "ID belum diatur" (NEVER show NIK/KTP)
    │
    ├─ Division: division → divisionName → divisi
    │
    └─ Name: fullName → namaLengkap → name → Firebase Auth displayName
         ↓ (if not found)
         └─ Firebase Auth email prefix
         
    ↓
Set user state with all fields
    ↓
Display in header with proper labels
```

---

## Testing Checklist

- [ ] Create test user in Firebase Auth
- [ ] Create employee_profiles document with:
  - [ ] `brandName` field (test with different variations)
  - [ ] `employeeId` field (test with different names)
  - [ ] `division` field
  - [ ] `fullName` field
- [ ] Login and verify console logs show correct field mapping
- [ ] Verify header displays correct brand name
- [ ] Verify header displays correct employee ID
- [ ] Verify division shows with emoji
- [ ] Test with missing `employeeId` → should show "ID belum diatur"
- [ ] Test with multiple field variations → verify correct priority
- [ ] Verify NO KTP/NIK displayed anywhere
- [ ] Check console logs for field source tracing

---

## Field Name Variations Reference

### If HRP Utama Uses Different Field Names
Update the mapping in `use-user.tsx` lines 63-75:

| Purpose | Current Fields | Add Custom |
|---------|---|---|
| Brand | brandName, companyName, company, unitName, brand | `\|\| employeeProfileData?.customBrandField` |
| Employee ID | employeeId, employeeNumber, nomorIndukKaryawan, nomorInduk, nip | `\|\| employeeProfileData?.customIdField` |
| Division | division, divisionName, divisi | `\|\| employeeProfileData?.customDivField` |
| Name | fullName, namaLengkap, name | `\|\| employeeProfileData?.customNameField` |

---

## Files Modified

1. **src/firebase/auth/use-user.tsx**
   - Enhanced field mapping with all variations
   - Removed NIK from employeeId fallback
   - Added comprehensive debug logging
   - Improved fallback logic to not override employee_profiles data

2. **src/app/absen/page.tsx**
   - Updated header display with clear labels
   - Shows "ID belum diatur" when employeeId empty
   - Added emoji indicators for clarity
   - Proper spacing and organization

---

## Important Notes

1. **NIK/KTP Policy**: Absolutely NO fallback to NIK/KTP numbers. If employeeId not found, show "ID belum diatur" message.

2. **Brand Priority**: Employee_profiles brand is FINAL. Only fallback to old sources if employee_profiles completely empty.

3. **Debug Logs**: Used in development to trace which field is being read. Should be disabled before production or wrapped in `process.env.NODE_ENV === 'development'` check.

4. **HRP Utama Synchronization**: Changes will automatically pull latest data on next login. No cache or local storage used.

5. **Backward Compatibility**: Code still handles old data structures gracefully through fallback chain, but displays new data correctly when available.

---

## Sign-Off

- **Status**: ✅ READY FOR TESTING
- **Date**: 2026-06-05
- **Changes**: Data mapping fixes only, no business logic changes
- **Impact**: Display only, no Firestore rules or auth changes
