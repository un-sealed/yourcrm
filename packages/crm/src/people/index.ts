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
  AuditWriter,
  EventEmitter,
  PeopleServiceContext,
  PeopleServiceDeps,
  PeopleStore,
  PersonContact,
  PersonListQuery,
  PersonListResult,
  PersonRecord,
  PersonWithContacts,
} from "./types"
