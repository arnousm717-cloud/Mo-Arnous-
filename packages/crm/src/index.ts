export {
  createCompany,
  getCompanyById,
  getCompanyByIdIncludingDeleted,
  listCompanies,
  updateCompany,
  softDeleteCompany,
  type Company,
  type CreateCompanyInput,
  type UpdateCompanyInput,
  type ListCompaniesInput,
} from "./companies";
export {
  createContact,
  getContactById,
  listContacts,
  updateContact,
  softDeleteContact,
  type Contact,
  type CreateContactInput,
  type UpdateContactInput,
  type ListContactsInput,
} from "./contacts";
export {
  CrmError,
  ValidationError,
  DuplicateContactEmailError,
  InvalidCompanyRelationshipError,
  InvalidOwnerError,
} from "./errors";
export { DEFAULT_LIMIT, MAX_LIMIT, type Page, type Cursor } from "./pagination";
