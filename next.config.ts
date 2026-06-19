import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  // Jangan bundle packages ini — biarkan Node.js load natively agar ESM/CJS interop benar.
  // Tanpa ini, webpack gagal bundle firebase-admin (yang pakai jwks-rsa → require(jose) → ESM error).
  serverExternalPackages: [
    'firebase-admin',
    'firebase-admin/app',
    'firebase-admin/auth',
    'firebase-admin/firestore',
    '@simplewebauthn/server',
    'jwks-rsa',
    'jose',
  ],
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
