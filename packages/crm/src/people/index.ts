export { PersonNotFoundError, createPeopleService } from "./service"
export type { PeopleService } from "./service"
export {
  createPersonSchema,
  personEmailInputSchema,
  personPhoneInputSchema,
  personQuerySchema,
  personSchema,
  updatePersonSchema,
} from "./schemas"
export type { CreatePersonInput, PersonDto, PersonQuery, UpdatePersonInput } from "./schemas"
export type {
  PeopleServiceContext,
  PeopleServiceDeps,
  PeopleStore,
  PersonContact,
  PersonListQuery,
  PersonListResult,
  PersonRecord,
  PersonWithContacts,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
