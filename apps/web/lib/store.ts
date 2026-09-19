import { create } from "zustand"

export type Toast = { id: string; title: string; description?: string }

type WorkspaceSlice = {
  workspaceId: string | null
  workspaceName: string
  setWorkspace: (id: string, name: string) => void
}

type UiSlice = {
  sidebarOpen: boolean
  toggleSidebar: () => void
  toasts: Toast[]
  pushToast: (t: Omit<Toast, "id">) => void
  dismissToast: (id: string) => void
}

/** Client UI state (Zustand). Server state lives in TanStack Query. */
export const useWorkspaceStore = create<WorkspaceSlice>()((set) => ({
  workspaceId: null,
  workspaceName: "Select workspace",
  setWorkspace: (workspaceId, workspaceName) => set({ workspaceId, workspaceName }),
}))

export const useUiStore = create<UiSlice>()((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toasts: [],
  pushToast: (t) =>
    set((s) => ({ toasts: [...s.toasts, { ...t, id: crypto.randomUUID() }].slice(-5) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
