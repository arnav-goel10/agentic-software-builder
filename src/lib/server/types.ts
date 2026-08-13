export type ProjectStatus = "active" | "archived";

export type MessageRole = "user" | "assistant" | "system";

export type RunStatus =
  | "queued"
  | "planning"
  | "executing"
  | "validating"
  | "repairing"
  | "completed"
  | "failed"
  | "cancelled";

export type StepPhase =
  | "spec"
  | "architect"
  | "scaffold"
  | "coder"
  | "review"
  | "validate"
  | "repair"
  | "qa"
  | "finalize";

export type StepStatus = "pending" | "running" | "complete" | "error";

export type RunArtifactKind = "spec" | "qa" | "preview_risk" | "memory" | "metrics";

export type ExecutionMode = "feature_mode" | "followup_fix_mode";

export type TaskObjectiveType = "direct_fix" | "supporting_refactor" | "verification";

export type NoOpClassification = "already_satisfied" | "mis_scoped_task" | "model_noop";

export type GeneratedFile = {
  name: string;
  code: string;
  language?: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  current_snapshot_id: string | null;
  created_at: number;
  updated_at: number;
};

export type ThreadRow = {
  id: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  role: MessageRole;
  content: string;
  meta_json: string;
  created_at: number;
};

export type ThreadSummaryRow = {
  id: string;
  thread_id: string;
  start_message_id: string;
  end_message_id: string;
  summary_json: string;
  created_at: number;
};

export type MemoryCardType = "decision" | "constraint" | "bugfix" | "anti_pattern";

export type MemoryCardRow = {
  id: string;
  project_id: string;
  type: MemoryCardType;
  text: string;
  source_run_id: string | null;
  weight: number;
  created_at: number;
  updated_at: number;
};

export type MemoryRetrievalLogRow = {
  id: string;
  run_id: string;
  phase: string;
  selected_card_ids_json: string;
  dropped_card_ids_json: string;
  token_estimate: number;
  created_at: number;
};

export type RunRow = {
  id: string;
  project_id: string;
  thread_id: string;
  trigger_message_id: string;
  status: RunStatus;
  model: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export type RunStepRow = {
  id: string;
  run_id: string;
  seq: number;
  phase: StepPhase;
  status: StepStatus;
  title: string;
  detail: string;
  payload_json: string;
  started_at: number | null;
  finished_at: number | null;
};

export type SnapshotRow = {
  id: string;
  project_id: string;
  run_id: string;
  parent_snapshot_id: string | null;
  summary: string;
  files_json: string;
  created_at: number;
};

export type RunArtifactRow = {
  id: string;
  run_id: string;
  kind: RunArtifactKind;
  title: string;
  content_json: string;
  created_at: number;
};

export type ProjectSummary = {
  project: ProjectRow;
  currentSnapshot: SnapshotRow | null;
  latestRun: RunRow | null;
};

export type ParsedMessage = {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  meta: Record<string, unknown>;
  createdAt: number;
};

export type ParsedRunStep = {
  id: string;
  runId: string;
  seq: number;
  phase: StepPhase;
  status: StepStatus;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  startedAt: number | null;
  finishedAt: number | null;
};

export type ParsedSnapshot = {
  id: string;
  projectId: string;
  runId: string;
  parentSnapshotId: string | null;
  summary: string;
  files: GeneratedFile[];
  createdAt: number;
};

export type ParsedRunArtifact = {
  id: string;
  runId: string;
  kind: RunArtifactKind;
  title: string;
  content: Record<string, unknown>;
  createdAt: number;
};

export type ParsedThreadSummary = {
  id: string;
  threadId: string;
  startMessageId: string;
  endMessageId: string;
  summary: Record<string, unknown>;
  createdAt: number;
};

export type ParsedMemoryCard = {
  id: string;
  projectId: string;
  type: MemoryCardType;
  text: string;
  sourceRunId: string | null;
  weight: number;
  createdAt: number;
  updatedAt: number;
};

export type ThreadSummaryPayload = {
  currentGoal: string;
  lockedConstraints: string[];
  knownFailures: string[];
  verifiedFixes: string[];
  openUnknowns: string[];
};

export type ParsedMemoryRetrievalLog = {
  id: string;
  runId: string;
  phase: string;
  selectedCardIds: string[];
  droppedCardIds: string[];
  tokenEstimate: number;
  createdAt: number;
};
