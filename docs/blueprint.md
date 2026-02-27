# **App Name**: PresenGO

## Core Features:

- User Authentication: Secure user login/logout via Firebase Email/Password Authentication, with automatic redirects for authenticated and unauthenticated states.
- Single-Screen Attendance Interface: A clean, mobile-first interface featuring the user's name, a prominent dynamic 'TAP IN' / 'TAP OUT' button, and real-time status display including attendance mode (ONSITE/OFFSITE), location validation, accuracy, and anomaly flags.
- Secure Attendance Submission: Client captures attendance data (type, timestamp, location, deviceId, optional selfie) and securely transmits it to an HTTPS Cloud Function (submitAttendance), which performs validation, geofencing against work_locations, and then writes the attendance event to the 'attendance_events' Firestore collection. Direct client writes to attendance_events are prohibited.
- Geolocation and Anomaly Detection: Determines ONSITE/OFFSITE mode based on current GPS location against defined work_locations. Flags anomalies automatically if location accuracy is poor (>80m), near boundary (<=20m), or on a new device, triggering a mandatory selfie.
- Mandatory Selfie with Watermarking: When an attendance event requires a selfie (OFFSITE, ANOMALY, NEW_DEVICE), the client initiates a camera capture. The captured image is sent to the Cloud Function, which stores the raw image and applies a modern server-side watermark with relevant attendance data (name, timestamp, mode, location, accuracy, unique code), storing both versions in Firebase Storage.
- Device Binding Management: A unique UUID device ID is generated and stored persistently on the client. The first time a user taps in on a device, the Cloud Function binds this device ID to the user's 'primaryDeviceId' field in their 'users' Firestore document, triggering a NEW_DEVICE flag and mandatory selfie for subsequent taps on different devices.
- Firebase Environment Validation Tool: On application startup, a validation tool checks for the presence of all required NEXT_PUBLIC_FIREBASE_* environment variables. If any are missing, it throws a clear error: 'Missing Firebase env vars. Check NEXT_PUBLIC_FIREBASE_*' to prevent incorrect Firebase project usage.

## Style Guidelines:

- Primary color: A deep, professional blue-violet (#593399), suggesting reliability and modern efficiency.
- Background color: A very light, desaturated blue-violet (#F5F2F7), providing a clean, spacious canvas that hints at the primary hue.
- Accent color: A vibrant, clear blue (#5B7FFF), chosen to provide high contrast for call-to-action elements and highlight important statuses, sitting analogously to the primary on the color wheel.
- Body and headline font: 'Inter', a grotesque-style sans-serif for its modern, neutral, and highly legible appearance, ideal for clear display of critical information and a mobile-first UI.
- Utilize minimalist line icons for clarity and speed. Key icons include 'TAP IN'/'TAP OUT' states, location validation indicators (e.g., checkmark, 'X'), and distinct symbols for anomaly flags, ensuring immediate understanding on a small screen.
- A focused, single-screen, mobile-first layout with the central TAP button dominating for immediate interaction. Supporting information (user name, status, flags) is presented concisely above or below, maintaining a clean and uncluttered interface to facilitate rapid user action without distractions.
- Subtle, functional animations for feedback, such as a quick tap confirmation or a brief loading indicator during attendance submission. Avoid any animations that introduce delays or hinder the app's responsiveness, prioritizing speed and efficiency.