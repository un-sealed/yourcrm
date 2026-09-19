export { TaskNotFoundError, createTasksService } from "./service"
export type { TasksService } from "./service"
export { createTaskSchema, taskQuerySchema, taskSchema, updateTaskSchema } from "./service"
export type { CreateTaskInput, TaskDto, TaskQuery, UpdateTaskInput } from "./service"
export type {
  TaskAuditInput,
  TaskListQuery,
  TaskListResult,
  TaskRecord,
  TasksServiceContext,
  TasksServiceDeps,
  TasksStore,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
