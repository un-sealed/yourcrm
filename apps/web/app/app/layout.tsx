import { AppShell } from "@/components/app-shell"

/** Authenticated app layout: nav shell wraps every /app route. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
