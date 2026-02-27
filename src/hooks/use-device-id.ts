
'use client';

import { useState, useEffect } from 'react';

export function useDeviceId() {
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => {
    let id = localStorage.getItem('presengo_device_id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('presengo_device_id', id);
    }
    setDeviceId(id);
  }, []);

  return deviceId;
}
