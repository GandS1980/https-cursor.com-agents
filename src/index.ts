export { SalesWrapper } from "./sales-wrapper";
export { OpenClawClient } from "./openclaw-client";
export { SalesStore } from "./store";
export { loadConfig, DEFAULT_CONFIG, RECRUITERSTACK_PRODUCT } from "./config";

// Modules
export { LeadGenerationModule } from "./modules/lead-generation";
export { AppointmentSchedulerModule } from "./modules/appointment-scheduler";
export { SalesCallModule } from "./modules/sales-call";
export { DealPipelineModule } from "./modules/deal-pipeline";
export {
  ClayIntakeModule,
  createClayIntakeServer,
  mapClayRow,
} from "./modules/clay-intake";

// Types
export type {
  Lead,
  LeadStatus,
  Appointment,
  AppointmentStatus,
  SalesCall,
  CallOutcome,
  Deal,
  DealStage,
  PipelineMetrics,
  OpenClawConfig,
  OpenClawMessage,
  OpenClawResponse,
  SalesWrapperConfig,
  ProductConfig,
  IdealCustomerProfile,
} from "./types";

export type { ProspectInput } from "./modules/lead-generation";
export type {
  ClayRow,
  ClayIntakeResult,
  ClayIntakeServerOptions,
} from "./modules/clay-intake";
export type { ScheduleRequest } from "./modules/appointment-scheduler";
export type { CallMessage } from "./modules/sales-call";
