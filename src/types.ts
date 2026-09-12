export type Agent = {
  id: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  color: string;
  provider: string;
  permission_level: "read_only" | "standard" | "autonomous";
  workspace: string;
  avatar_data: string;
  benched: boolean;
  status: string;
  created_at: string;
};
export type Team = {
  id: string;
  name: string;
  objective: string;
  workspace: string;
  members: string[];
};
export type Conversation = {
  id: string;
  name: string;
  agent_id: string | null;
  team_id: string | null;
  preview: string;
  unread: number;
  pinned: number;
  archived: number;
  muted: number;
  updated_at: string;
};
export type Message = {
  attachments?: { id: string; name: string; size: number }[];
  reactions?: string[];
  id: string;
  conversation_id: string;
  agent_id: string | null;
  role: string;
  content: string;
  kind: string;
  status: string;
  reply_to: string | null;
  created_at: string;
};
export type Task = {
  id: string;
  conversation_id: string;
  message_id: string;
  owner_id: string;
  title: string;
  objective: string;
  status: string;
  kind: string;
  workspace: string;
  result: string;
  error: string;
  verification: string;
  created_at: string;
  started_at: string;
  completed_at: string;
  root_task_id?: string;
  repository?: string;
  base_commit?: string;
  branch?: string;
  worktree_path?: string;
  criteria_total?: number;
  criteria_passed?: number;
  has_receipt?: number;
};
export type Approval = {
  id: string;
  task_id: string;
  title: string;
  detail: string;
  status: string;
  created_at: string;
};
export type Memory = { id: string; scope_id: string; content: string };
export type Provider = {
  id: string;
  name: string;
  status: string;
  version?: string;
  detail?: string;
};
export type Settings = {
  theme: string;
  parallelLimit: number;
  repairLimit: number;
  compatible: { name: string; endpoint: string; model: string } | null;
  hasKey: boolean;
  canSaveKey: boolean;
  keyStorage: "encrypted" | "session";
  directory: string;
  workspaceName: string;
};
export type State = {
  agents: Agent[];
  teams: Team[];
  conversations: Conversation[];
  tasks: Task[];
  approvals: Approval[];
  needsYou: AttentionItem[];
  memories: Memory[];
  providers: Provider[];
  integrations: Integration[];
  mcpConnections: McpConnection[];
  projectProfiles: ProjectProfile[];
  planning: string[];
  settings: Settings;
};
export type Integration = {
  id: string;
  provider: string;
  name: string;
  type: string;
  status: string;
  detail: string;
  capabilities_json: string;
  updated_at: string;
};
export type McpConnection = {
  id: string;
  url: string;
  server_name: string;
  status: string;
  detail: string;
  protocol_version: string;
  capabilities_json: string;
  updated_at: string;
};
export type ProjectProfile = {
  id: string;
  workspace: string;
  name: string;
  updated_at: string;
};
export type AttentionItem = {
  id: string;
  task_id: string | null;
  type: string;
  title: string;
  detail: string;
  status: string;
  action_json: string;
  created_at: string;
};
export type Attachment = { name: string; content: string };
export type TaskDetail = {
  task: Task;
  events: { id: string; type: string; detail: string; created_at: string }[];
  dependencies: Task[];
  outcome?: {
    id: string;
    goal: string;
    status: string;
    constraints_json: string;
  };
  criteria: { id: string; type: string; description: string; status: string }[];
  evidence: {
    id: string;
    type: string;
    source: string;
    status: string;
    summary: string;
    created_at: string;
  }[];
  review?: {
    verdict: string;
    summary: string;
    issues_json: string;
    checks_json: string;
  };
  receipt?: { id: string; content: string; created_at: string };
};
export const activeStatuses = [
  "running",
  "queued",
  "waiting_dependency",
  "waiting_approval",
];
export const statusLabel: Record<string, string> = {
  available: "Available",
  working: "Working",
  running: "Working",
  needs_you: "Needs you",
  waiting_approval: "Needs you",
  queued: "Queued",
  waiting_dependency: "Waiting",
  benched: "Benched",
  completed: "Completed",
  failed: "Couldn’t finish",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  connected: "Connected",
  configured: "Configured",
  not_configured: "Not connected",
  authentication_required: "Sign-in required",
  unavailable: "Unavailable",
  reviewed: "Reviewed",
  verified: "Verified",
  unverified: "Not verified",
};
