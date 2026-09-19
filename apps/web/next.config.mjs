/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; compile them in the web bundle.
  transpilePackages: [
    "@yourcrm/ui",
    "@yourcrm/validation",
    "@yourcrm/config",
    "@yourcrm/auth",
    "@yourcrm/permissions",
    "@yourcrm/events",
  ],
  async rewrites() {
    const apiUrl = process.env.API_URL ?? "http://localhost:4000"
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }]
  },
}

export default nextConfig
