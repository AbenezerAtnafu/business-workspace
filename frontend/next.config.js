/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Docker image (Dockerfile) builds with NEXT_OUTPUT=standalone: Next
  // traces exactly the files the server needs into .next/standalone, so the
  // runtime image carries no node_modules tree. Left off for `npm run build`
  // on a laptop so `npm start` keeps working as before.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
};

module.exports = nextConfig;
