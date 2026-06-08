# Quick Verification Guide - Employee Data Mapping

## What Changed?
1. **Brand mapping**: Now reads from `employee_profiles` first, proper field priority
2. **Employee ID**: Uses Nomor Induk Karyawan only, NOT NIK/KTP
3. **Header display**: Shows clear labels and proper employee ID
4. **Debug logs**: Added to trace which fields are being used

---

## Quick Test Steps

### 1. Prepare Test Data in Firestore

Create/update an `employee_profiles` document:

```json
{
  "uid": "USER_UID_HERE",
  "fullName": "John Doe",
  "brandName": "PT Maju Jaya",
  "division": "Engineering",
  "employeeId": "EMP-2024-001",
  "employmentType": "permanent",
  "attendanceMethod": "web_absen"
}
```

**Field Name Variations** (if using different names):
- Brand: `brandName` | `companyName` | `company` | `unitName` | `brand`
- Employee ID: `employeeId` | `employeeNumber` | `nomorIndukKaryawan` | `nomorInduk` | `nip`
- Division: `division` | `divisionName` | `divisi`
- Name: `fullName` | `namaLengkap` | `name`

### 2. Login to Web Absen

1. Open browser DevTools (F12)
2. Go to Console tab
3. Login with test user
4. Look for these logs:

```
[EMPLOYEE SYNC] UID Login: USER_UID_HERE
[EMPLOYEE SYNC] Profile found: { uid: '...', profileKeys: [...] }
[EMPLOYEE SYNC] Field mapping: {
  brandField: 'brandName',          ← which field was used
  brandValue: 'PT Maju Jaya',       ← what value was read
  employeeIdField: 'employeeId',
  employeeIdValue: 'EMP-2024-001',
  divisionField: 'division',
  divisionValue: 'Engineering'
}
```

### 3. Verify Header Display

Check Web Absen header shows:
- ✅ Employee name: "John Doe"
- ✅ Brand: "PT MAJU JAYA" (uppercase)
- ✅ Division: "📍 Engineering"
- ✅ Employee ID: "🆔 EMP-2024-001"
- ✅ Attendance method badge: "web absen"

### 4. Test Empty Employee ID

Create another user with NO `employeeId` field:

```json
{
  "uid": "USER_UID_2",
  "fullName": "Jane Smith",
  "brandName": "PT Maju Jaya",
  "division": "HR"
  // NO employeeId field
}
```

Verify header shows: "🆔 ID belum diatur" (NOT showing NIK)

### 5. Test Field Name Variations

Create users with different field names:

```json
// Using nomorIndukKaryawan instead
{
  "uid": "USER_UID_3",
  "namaLengkap": "Ahmad Rizki",
  "companyName": "PT Karya Bersama",
  "divisionName": "Finance",
  "nomorIndukKaryawan": "KY-2024-105"
}
```

Verify it still works and logs show correct field names.

### 6. Test Brand Fallback

Test case: Create user with empty `brandName` but has `userData.brandId`:

```json
{
  "uid": "USER_UID_4",
  "fullName": "Test User",
  // NO brand fields in employee_profiles
  // Only has brandId in users/{uid} collection
}
```

Should see logs:
```
[EMPLOYEE SYNC] Brand fetched from brands collection (fallback): PT Fallback Brand
```

---

## Debugging Checklist

If brand/ID shows wrong value:

1. **Check Firestore Data**
   - [ ] employee_profiles document exists
   - [ ] employee_profiles.uid matches Firebase Auth uid
   - [ ] brandName field exists and has correct value
   - [ ] employeeId field exists (not empty)

2. **Check Console Logs**
   - [ ] `[EMPLOYEE SYNC]` logs appear
   - [ ] Profile found message shows (not "Profile NOT found")
   - [ ] Field mapping shows correct field names
   - [ ] Field mapping shows correct values

3. **Check Field Names**
   - [ ] Field names match one of the accepted variations
   - [ ] No typos in field names
   - [ ] Field not empty/null/undefined in Firestore

4. **Check Firestore Rules**
   - [ ] User can read their own employee_profiles
   - [ ] employee_profiles rule in firestore.rules shows self-read access

---

## Removing Debug Logs (Production)

When ready for production, remove console.log statements:

**Option 1**: Remove completely
```bash
# Search and remove [EMPLOYEE SYNC] logs
```

**Option 2**: Wrap in environment check
```typescript
if (process.env.NODE_ENV === 'development') {
  console.log('[EMPLOYEE SYNC] ...');
}
```

---

## Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| Brand shows "Brand belum diatur" | No brand in employee_profiles | Add `brandName` to employee_profiles |
| ID shows "ID belum diatur" | No employeeId in employee_profiles | Add one of: `employeeId`, `employeeNumber`, `nomorIndukKaryawan`, `nomorInduk`, `nip` |
| Division not showing | No division in employee_profiles | Add one of: `division`, `divisionName`, `divisi` |
| Profile NOT found message | employee_profiles/{uid} doesn't exist | Create employee_profiles document with correct uid |
| Wrong brand showing | Using old data source | Check if employee_profiles.brandName is being read (check logs) |
| KTP/NIK showing as ID | Should never happen (code prevents it) | Check if using custom field not in fallback chain |

---

## Field Name Mapping Reference

### If Your HRP Uses Different Fields

| Field Purpose | Standard Names | Your HRP Name? |
|---|---|---|
| Brand | brandName, companyName, company, unitName, brand | ? |
| Employee ID | employeeId, employeeNumber, nomorIndukKaryawan, nomorInduk, nip | ? |
| Division | division, divisionName, divisi | ? |
| Full Name | fullName, namaLengkap, name | ? |

**If your HRP uses different names**: Update `src/firebase/auth/use-user.tsx` lines 63-73 with your field names.

---

## Performance Notes

- ✅ Data fetched once at login (no real-time sync)
- ✅ Re-login to get updated data from HRP utama
- ✅ Header display instant (no extra queries)
- ✅ Console logs minimal performance impact

---

## Support

If data mapping still incorrect after following this guide:

1. Share console logs from `[EMPLOYEE SYNC]` section
2. Share employee_profiles document structure (without sensitive data)
3. Confirm which field names are used in HRP utama
4. Check Firestore rules allow user to read employee_profiles

---

## Summary

✅ **Brand now reads from employee_profiles** (proper field priority)
✅ **Employee ID is Nomor Induk Karyawan** (no NIK/KTP fallback)
✅ **Header shows clear labels** with emoji indicators
✅ **Debug logs help identify issues** (easy to disable for production)
✅ **Multiple field name variations supported** (flexible for different HRP schemas)

**Ready to test!** 🚀
