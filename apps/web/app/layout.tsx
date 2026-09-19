import type { Metadata, Viewport } from "next"
import "./globals.css"
import { Providers } from "./providers"
import { Toaster } from "@/components/toaster"
import { ServiceWorkerRegister } from "@/components/service-worker-register"

export const metadata: Metadata = {
  title: "YourCRM",
  description: "AI-native, self-hostable open-source CRM",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2563eb",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
        <Toaster />
        <ServiceWorkerRegister />
      </body>
    </html>
  )
}
