import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "./providers"
import { Toaster } from "@/components/toaster"

export const metadata: Metadata = {
  title: "YourCRM",
  description: "AI-native, self-hostable open-source CRM",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  )
}
