
export function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface AddressDetail {
  displayName: string;
  road?: string;
  neighbourhood?: string;
  village?: string;
  kelurahan?: string;
  district?: string;
  kecamatan?: string;
  city?: string;
  regency?: string;
  kabupatenKota?: string;
  province?: string;
  postcode?: string;
  country?: string;
}

export async function getDetailedAddress(lat: number, lng: number): Promise<AddressDetail> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { 'Accept-Language': 'id-ID' } }
    );
    const data = await res.json();
    const a = data.address || {};
    return {
      displayName: data.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      road:          a.road || a.pedestrian || a.path || a.footway,
      neighbourhood: a.neighbourhood || a.hamlet || a.allotments,
      village:       a.village || a.town,
      kelurahan:     a.suburb || a.quarter,
      district:      a.district,
      kecamatan:     a.county || a.municipality,
      city:          a.city || a.town || a.municipality,
      regency:       a.county,
      kabupatenKota: a.city || a.county,
      province:      a.state,
      postcode:      a.postcode,
      country:       a.country,
    };
  } catch {
    return { displayName: `${lat.toFixed(6)}, ${lng.toFixed(6)}` };
  }
}

// backward-compat wrapper
export async function getAddressFromLatLng(lat: number, lng: number): Promise<string> {
  const d = await getDetailedAddress(lat, lng);
  return d.displayName;
}
