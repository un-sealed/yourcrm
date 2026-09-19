"use client"

import { useState } from "react"
import { QueryClient, QueryClientProvider, QueryCache } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"

/** TanStack Query (server state) + theme system providers. */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error, query) => {
            console.error(`[query] ${String(query.queryKey[0])} failed:`, error)
          },
        }),
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 },
        },
      }),
  )
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ThemeProvider>
  )
}
