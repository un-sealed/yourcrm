export { CompanyNotFoundError, createCompaniesService } from "./service"
export type { CompaniesService } from "./service"
export {
  companyAddressInputSchema,
  companyQuerySchema,
  companySchema,
  createCompanySchema,
  updateCompanySchema,
} from "./schemas"
export type { CompanyDto, CompanyQuery, CreateCompanyInput, UpdateCompanyInput } from "./schemas"
export type {
  CompaniesServiceContext,
  CompaniesServiceDeps,
  CompaniesStore,
  CompanyAddressRecord,
  CompanyListQuery,
  CompanyListResult,
  CompanyRecord,
  CompanyWithAddresses,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
