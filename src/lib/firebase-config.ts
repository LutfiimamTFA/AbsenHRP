// Deprecated. Use config from '@/firebase/config' instead.
import { firebaseConfig as mainConfig } from '@/firebase/config';

export const firebaseConfig = mainConfig;

export function validateFirebaseEnv() {
  return true;
}
