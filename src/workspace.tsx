import { useEffect, useState } from "react";
import {
  Plus,
  Search,
  UserRound,
  Users,
  ArrowUpRight,
  MessageCircle,
  CheckCheck,
  Folder,
  Activity,
  Download,
  Code2,
  RefreshCw,
  Sun,
  Moon,
  Monitor,
  ChevronRight,
  PenLine,
  Trash2,
} from "lucide-react";
import { Avatar, IconButton, Modal, templates } from "./main";
import { api } from "./api";
import { State, Agent, Team, activeStatuses, statusLabel } from "./types";
import { eventText } from "./panels";
type Props = {
  view: string;
  state: State;
  refresh: () => Promise<void>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  openChat: (id: string) => void;
  onWorker: (a: Partial<Agent>) => void;
  onTeam: (t: Partial<Team>) => void;
  onTask: (id: string) => void;
  notify: (s: string) => void;
};
const workspaceScopes = (value: string) => {
  try {
    const scopes = JSON.parse(value || "[]");
    return Array.isArray(scopes)
      ? scopes.filter((item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};
function McpScopeEditor({
  connectionId,
  scopeJson,
  profiles,
  act,
}: {
  connectionId: string;
  scopeJson: string;
  profiles: State["projectProfiles"];
  act: Props["act"];
}) {
  const [scopes, setScopes] = useState(() => workspaceScopes(scopeJson));
  useEffect(() => setScopes(workspaceScopes(scopeJson)), [scopeJson]);
  return (
    <details>
      <summary>Project access</summary>
      <small>
        Limit this server to selected saved project profiles. Leave empty to
        keep it available globally.
      </small>
      {profiles.length ? (
        <form
          className="field"
          onSubmit={(event) => {
            event.preventDefault();
            act(() =>
              api(`/mcp/${connectionId}/scopes`, "PUT", { workspaces: scopes }),
            );
          }}
        >
          {profiles.map((profile) => (
            <label key={profile.workspace}>
              <input
                type="checkbox"
                checked={scopes.includes(profile.workspace)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...new Set([...current, profile.workspace])]
                      : current.filter((scope) => scope !== profile.workspace),
                  )
                }
              />
              {profile.name}
            </label>
          ))}
          <button className="text-button">Save project access</button>
        </form>
      ) : (
        <small>Save a project profile before assigning project access.</small>
      )}
    </details>
  );
}
function IntegrationScopeEditor({
  integrationId,
  scopeJson,
  profiles,
  act,
}: {
  integrationId: string;
  scopeJson: string;
  profiles: State["projectProfiles"];
  act: Props["act"];
}) {
  const [scopes, setScopes] = useState(() => workspaceScopes(scopeJson));
  useEffect(() => setScopes(workspaceScopes(scopeJson)), [scopeJson]);
  return (
    <details>
      <summary>Project access</summary>
      <small>
        Restrict this integration to selected project profiles. Leave empty to
        keep it available globally.
      </small>
      {profiles.length ? (
        <form
          className="field"
          onSubmit={(event) => {
            event.preventDefault();
            act(() =>
              api(`/integrations/${integrationId}/scopes`, "PUT", {
                workspaces: scopes,
              }),
            );
          }}
        >
          {profiles.map((profile) => (
            <label key={profile.workspace}>
              <input
                type="checkbox"
                checked={scopes.includes(profile.workspace)}
                onChange={(event) =>
                  setScopes((current) =>
                    event.target.checked
                      ? [...new Set([...current, profile.workspace])]
                      : current.filter((scope) => scope !== profile.workspace),
                  )
                }
              />
              {profile.name}
            </label>
          ))}
          <button className="text-button">Save project access</button>
        </form>
      ) : (
        <small>Save a project profile before assigning project access.</small>
      )}
    </details>
  );
}
function IntegrationTokenEditor({
  integration,
  act,
  notify,
}: {
  integration: State["integrations"][number];
  act: Props["act"];
  notify: Props["notify"];
}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!integration.credential_configurable) return null;
  const save = async (value: string) => {
    setSaving(true);
    setError("");
    try {
      await act(() =>
        api(`/integrations/${integration.id}/token`, "PUT", { token: value }),
      );
      setToken("");
      notify(
        value
          ? `${integration.name} access token saved securely.`
          : `${integration.name} access token removed.`,
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <details>
      <summary>Connect account</summary>
      <small>
        Your access token is stored in this desktop's encrypted credential vault
        and is never added to the Roster database.
      </small>
      <form
        className="field"
        onSubmit={(event) => {
          event.preventDefault();
          void save(token);
        }}
      >
        <input
          aria-label={`${integration.name} access token`}
          autoComplete="off"
          maxLength={10000}
          placeholder={`${integration.name} access token`}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="text-button" disabled={saving || !token.trim()}>
          {saving ? "Checking account..." : "Save and check account"}
        </button>
      </form>
      {integration.credential_configured && (
        <button
          className="text-button"
          disabled={saving}
          onClick={() => void save("")}
          type="button"
        >
          Remove saved token
        </button>
      )}
      {error && <small className="form-error">{error}</small>}
    </details>
  );
}
function ProjectEnvironmentEditor({
  profile,
  act,
  notify,
}: {
  profile: State["projectProfiles"][number];
  act: Props["act"];
  notify: Props["notify"];
}) {
  const empty = {
    setup: [] as string[],
    filesToCopy: [] as string[],
    devCommand: "",
    testCommand: "",
    buildCommand: "",
  };
  const [value, setValue] = useState(profile.environment || empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(
    () => setValue(profile.environment || empty),
    [profile.environment],
  );
  const lines = (text: string) =>
    text
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await act(() =>
        api("/projects/environment", "PUT", {
          workspace: profile.workspace,
          ...value,
        }),
      );
      notify(`${profile.name} environment saved.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <details className="provider-detail">
      <summary>{profile.name} environment</summary>
      <small>{profile.workspace}</small>
      <form className="form-body" onSubmit={save}>
        <label className="field">
          Setup commands
          <textarea
            aria-label={`${profile.name} setup commands`}
            maxLength={10000}
            placeholder="One command per line"
            value={value.setup.join("\n")}
            onChange={(event) =>
              setValue({ ...value, setup: lines(event.target.value) })
            }
          />
        </label>
        <label className="field">
          Files to copy into isolated worktrees
          <textarea
            aria-label={`${profile.name} files to copy`}
            maxLength={6000}
            placeholder=".env.local"
            value={value.filesToCopy.join("\n")}
            onChange={(event) =>
              setValue({ ...value, filesToCopy: lines(event.target.value) })
            }
          />
        </label>
        <div className="form-row">
          <label className="field">
            Development command
            <input
              maxLength={1000}
              value={value.devCommand}
              onChange={(event) =>
                setValue({ ...value, devCommand: event.target.value })
              }
            />
          </label>
          <label className="field">
            Test command
            <input
              maxLength={1000}
              value={value.testCommand}
              onChange={(event) =>
                setValue({ ...value, testCommand: event.target.value })
              }
            />
          </label>
        </div>
        <label className="field">
          Build command
          <input
            maxLength={1000}
            value={value.buildCommand}
            onChange={(event) =>
              setValue({ ...value, buildCommand: event.target.value })
            }
          />
        </label>
        <small>
          Roster detects these values but never runs setup or copies files until
          a worker requests an approved action in its isolated workspace.
        </small>
        <button className="text-button" disabled={saving}>
          {saving ? "Saving..." : "Save environment"}
        </button>
        {error && <small className="form-error">{error}</small>}
      </form>
    </details>
  );
}
function IntegrationReadPanel({
  integration,
  act,
}: {
  integration: State["integrations"][number];
  act: Props["act"];
}) {
  const [organization, setOrganization] = useState("");
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  if (
    !integration.credential_configured ||
    !["sentry", "linear"].includes(integration.provider)
  )
    return null;
  return (
    <details>
      <summary>Read project context</summary>
      <form
        className="field"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            const response = await api<{ result: unknown }>(
              `/integrations/${integration.id}/read`,
              "POST",
              { organization, project, query },
            );
            setResult(JSON.stringify(response.result, null, 2));
            await act(async () => undefined);
          } catch (reason) {
            setError((reason as Error).message);
          }
        }}
      >
        {integration.provider === "sentry" && (
          <div className="form-row">
            <label className="field">
              Organization
              <input
                required
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
              />
            </label>
            <label className="field">
              Project ID or slug
              <input
                value={project}
                onChange={(event) => setProject(event.target.value)}
              />
            </label>
          </div>
        )}
        <label className="field">
          {integration.provider === "sentry" ? "Issue filter" : "Issue search"}
          <input
            required={integration.provider === "linear"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="text-button">Read current context</button>
      </form>
      {error && <small className="form-error">{error}</small>}
      {result && <pre>{result}</pre>}
    </details>
  );
}
function SentryWatchEditor({
  integration,
  act,
  notify,
}: {
  integration: State["integrations"][number];
  act: Props["act"];
  notify: Props["notify"];
}) {
  const [organization, setOrganization] = useState("");
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  if (integration.provider !== "sentry" || !integration.credential_configured)
    return null;
  return (
    <details>
      <summary>Watch production problems</summary>
      <small>
        Roster establishes a baseline, then adds newly observed issues to Needs
        You. It will not edit code, deploy, or close Sentry issues.
      </small>
      <form
        className="field"
        onSubmit={(event) => {
          event.preventDefault();
          act(() =>
            api(`/integrations/${integration.id}/sentry-watch`, "PUT", {
              enabled: true,
              organization,
              project,
              query,
            }),
          ).then(() => notify("Sentry issue watch saved."));
        }}
      >
        <label className="field">
          Organization
          <input
            required
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
          />
        </label>
        <label className="field">
          Project ID or slug
          <input
            value={project}
            onChange={(event) => setProject(event.target.value)}
          />
        </label>
        <label className="field">
          Issue filter
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="text-button">Start watch</button>
      </form>
      <button
        className="text-button"
        type="button"
        onClick={() =>
          act(() =>
            api(`/integrations/${integration.id}/sentry-watch`, "PUT", {
              enabled: false,
              organization: "",
            }),
          ).then(() => notify("Sentry issue watch stopped."))
        }
      >
        Stop watch
      </button>
      <button
        className="text-button"
        type="button"
        onClick={() =>
          act(() =>
            api(
              `/integrations/${integration.id}/sentry-watch/check`,
              "POST",
              {},
            ),
          ).then(() => notify("Sentry issue watch checked."))
        }
      >
        Check now
      </button>
    </details>
  );
}
export default function WorkspaceView(p: Props) {
  const {
    view,
    state,
    act,
    openChat,
    onWorker,
    onTeam,
    onTask,
    refresh,
    notify,
  } = p;
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("All"),
    [remove, setRemove] = useState<Agent | null>(null),
    [removeError, setRemoveError] = useState("");
  useEffect(() => {
    setQuery("");
    setFilter("All");
  }, [view]);
  const descriptions: Record<string, string> = {
    Roster: "Good people for the work you care about.",
    Teams: "A shared purpose. The right people. One conversation.",
    Work: "Keep up with what your team is working on.",
    "Needs You": "The decisions and approvals that need your attention.",
    Files: "Everything you’ve shared, all in one place.",
    Activity: "The useful details behind the conversation.",
    Settings: "Make yourself at home.",
  };
  if (view === "Settings") return <SettingsView {...p} />;
  return (
    <div className="workspace-page">
      <header className="page-header">
        <div>
          <h1>{view === "Roster" ? "Your roster" : view}</h1>
          <p>{descriptions[view]}</p>
        </div>
        {view === "Roster" && (
          <button className="primary" onClick={() => onWorker({})}>
            <Plus size={16} />
            Add worker
          </button>
        )}
        {view === "Teams" && (
          <button className="primary" onClick={() => onTeam({})}>
            <Plus size={16} />
            New team
          </button>
        )}
      </header>
      {view === "Roster" && (
        <>
          <div className="page-toolbar">
            <div className="filters">
              {["All", "Available", "Working", "Benched"].map((f) => (
                <button
                  key={f}
                  className={filter === f ? "selected" : ""}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="search-field">
              <Search size={16} />
              <input
                aria-label="Search workers"
                placeholder="Find someone on your roster"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {!state.agents.length ? (
            <Empty
              icon={UserRound}
              title="Your next great hire is right here."
              text="Start with a role below, or create a worker that’s entirely your own."
              action="Create a worker"
              onAction={() => onWorker({})}
            />
          ) : (
            <div className="agent-grid">
              {state.agents
                .filter(
                  (a) =>
                    (filter === "All" || a.status === filter.toLowerCase()) &&
                    `${a.name} ${a.role}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                )
                .map((a) => (
                  <article key={a.id} className="agent-card">
                    <div className="agent-card-top">
                      <Avatar
                        name={a.name}
                        color={a.color}
                        image={a.avatar_data}
                        status={a.status}
                      />
                      <span className={`status-pill ${a.status}`}>
                        {statusLabel[a.status]}
                      </span>
                    </div>
                    <h2>{a.name}</h2>
                    <p className="role">{a.role}</p>
                    <p className="description">
                      {a.description || "Ready for a new conversation."}
                    </p>
                    <div className="agent-card-footer">
                      <button
                        className="text-button"
                        onClick={() => {
                          const c = state.conversations.find(
                            (c) => c.agent_id === a.id,
                          );
                          if (c) openChat(c.id);
                        }}
                      >
                        <MessageCircle size={14} />
                        Message
                      </button>
                      <div>
                        <IconButton
                          label={`Edit ${a.name}`}
                          onClick={() => onWorker(a)}
                        >
                          <PenLine size={15} />
                        </IconButton>
                        <IconButton
                          label={`${a.benched ? "Unbench" : "Bench"} ${a.name}`}
                          onClick={() =>
                            act(() =>
                              api(`/agents/${a.id}`, "PUT", {
                                ...a,
                                benched: !a.benched,
                              }),
                            )
                          }
                        >
                          <UserRound size={15} />
                        </IconButton>
                        <IconButton
                          label={`Remove ${a.name}`}
                          onClick={() => {
                            setRemove(a);
                            setRemoveError("");
                          }}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </div>
                  </article>
                ))}
            </div>
          )}
          <section className="template-section">
            <h2 className="section-title">
              A little inspiration <span>WORKER TEMPLATES</span>
            </h2>
            <div className="template-list">
              {templates.map((t) => (
                <button key={t.role} onClick={() => onWorker(t)}>
                  <span className={`template-icon ${t.color}`}>
                    <t.icon size={21} />
                  </span>
                  <Plus size={16} />
                  <strong>{t.role}</strong>
                  <p>{t.description}</p>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      {view === "Teams" &&
        (!state.teams.length ? (
          <Empty
            icon={Users}
            title="Better together."
            text="Bring workers into a group chat. Give them a shared objective and let the right person take the lead."
            action="Create a team"
            onAction={() => onTeam({})}
          />
        ) : (
          <div className="agent-grid">
            {state.teams.map((t) => (
              <article className="agent-card" key={t.id}>
                <div className="agent-card-top">
                  <Avatar name={t.name} team />
                  <IconButton
                    label={`Edit ${t.name}`}
                    onClick={() => onTeam(t)}
                  >
                    <PenLine size={17} />
                  </IconButton>
                </div>
                <h2>{t.name}</h2>
                <p className="role">{t.members.length} workers</p>
                <p className="description">
                  {t.objective || "A place to do good work together."}
                </p>
                <div className="agent-card-footer">
                  <div style={{ display: "flex", gap: 4 }}>
                    {t.members.slice(0, 4).map((id) => {
                      const a = state.agents.find((a) => a.id === id);
                      return (
                        a && (
                          <Avatar
                            key={id}
                            name={a.name}
                            color={a.color}
                            size="small"
                          />
                        )
                      );
                    })}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => {
                      const c = state.conversations.find(
                        (c) => c.team_id === t.id,
                      );
                      if (c) openChat(c.id);
                    }}
                  >
                    Open chat <ArrowUpRight size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ))}
      {view === "Work" && (
        <>
          <div className="page-toolbar">
            <div className="filters">
              {["All", "Working", "Needs you", "Done"].map((f) => (
                <button
                  key={f}
                  className={filter === f ? "selected" : ""}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          {!state.tasks.filter((t) => t.kind !== "chat").length ? (
            <Empty
              icon={CheckCheck}
              title="A clear desk. A fresh start."
              text="Give a worker something to do in chat. You’ll see assignments, progress, and results here."
            />
          ) : (
            <div className="work-list">
              {state.tasks
                .filter(
                  (t) =>
                    t.kind !== "chat" &&
                    (filter === "All" ||
                      (filter === "Working" &&
                        activeStatuses.includes(t.status)) ||
                      (filter === "Needs you" &&
                        ["waiting_approval", "failed"].includes(t.status)) ||
                      (filter === "Done" && t.status === "completed")),
                )
                .map((t) => (
                  <button
                    key={t.id}
                    className="work-row"
                    onClick={() => onTask(t.id)}
                  >
                    <Avatar
                      name={
                        state.agents.find((a) => a.id === t.owner_id)?.name ||
                        "R"
                      }
                      color={
                        state.agents.find((a) => a.id === t.owner_id)?.color
                      }
                      size="small"
                    />
                    <span className="work-name">
                      <strong>{t.title}</strong>
                      <small>
                        {state.agents.find((a) => a.id === t.owner_id)?.name ||
                          "Former worker"}{" "}
                        ·{" "}
                        {
                          state.conversations.find(
                            (c) => c.id === t.conversation_id,
                          )?.name
                        }
                      </small>
                    </span>
                    <span className={`status-pill ${t.status}`}>
                      {statusLabel[t.status]}
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
            </div>
          )}
        </>
      )}
      {view === "Needs You" && (
        <>
          {!state.needsYou.length ? (
            <Empty
              icon={CheckCheck}
              title="You are all caught up."
              text="Roster will collect decisions, approvals, and verification blockers here when your attention can move work forward."
            />
          ) : (
            <div className="work-list">
              {state.needsYou.map((item) => {
                const task = state.tasks.find((t) => t.id === item.task_id);
                return (
                  <div key={item.id}>
                    <button
                      className="work-row"
                      onClick={() => task && onTask(task.id)}
                    >
                      <span className="work-name">
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                      </span>
                      {task && (
                        <span className={`status-pill ${task.status}`}>
                          {statusLabel[task.status]}
                        </span>
                      )}
                      <ChevronRight size={16} />
                    </button>
                    {item.type !== "approval" && (
                      <>
                        {/^github_(ci|review|conflict|closed)$/.test(
                          item.type,
                        ) && (
                          <button
                            className="secondary"
                            onClick={() =>
                              act(() =>
                                api(`/attention/${item.id}/repair`, "POST", {}),
                              )
                            }
                          >
                            Let owner repair
                          </button>
                        )}
                        <button
                          className="text-button"
                          onClick={() =>
                            act(() =>
                              api(`/attention/${item.id}/resolve`, "POST", {}),
                            )
                          }
                        >
                          Mark resolved
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {view === "Files" && <FilesView state={state} />}{" "}
      {view === "Activity" && <ActivityView state={state} />}
      {remove && (
        <Modal title={`Remove ${remove.name}?`} onClose={() => setRemove(null)}>
          <div className="form-body">
            <p>
              This removes the worker from your roster and teams. Chat history
              and completed work stay saved.
            </p>
            {removeError && <p className="form-error">{removeError}</p>}
          </div>
          <footer className="form-actions">
            <button className="secondary" onClick={() => setRemove(null)}>
              Keep worker
            </button>
            <button
              className="danger"
              onClick={async () => {
                try {
                  await api(`/agents/${remove.id}`, "DELETE", {});
                  await p.refresh();
                  setRemove(null);
                } catch (e) {
                  setRemoveError((e as Error).message);
                }
              }}
            >
              Remove worker
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
  action,
  onAction,
}: {
  icon: typeof Users;
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-panel">
      <Icon size={34} />
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button className="primary" onClick={onAction}>
          <Plus size={16} />
          {action}
        </button>
      )}
    </div>
  );
}
function FilesView({ state }: { state: State }) {
  const [files, setFiles] = useState<
      {
        id: string;
        name: string;
        size: number;
        conversation_id: string;
        created_at: string;
        kind: string;
      }[]
    >([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    api<typeof files>("/files")
      .then(setFiles)
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);
  return error ? (
    <p className="form-error">{error}</p>
  ) : !loaded ? (
    <p className="muted-note">Opening shared files…</p>
  ) : !files.length ? (
    <Empty
      icon={Folder}
      title="A home for the things you share."
      text="Attach a text or source file to any conversation. Find it here whenever you need it."
    />
  ) : (
    <div className="file-table">
      {files.map((f) => (
        <div key={f.id} className="file-row">
          <Folder size={20} />
          <div>
            <strong>{f.name}</strong>
            <small>
              {
                state.conversations.find((c) => c.id === f.conversation_id)
                  ?.name
              }{" "}
              · {f.kind === "result" ? "Work result" : "Shared file"} ·{" "}
              {f.size < 1024
                ? `${f.size} B`
                : `${(f.size / 1024).toFixed(1)} KB`}
            </small>
          </div>
          <a href={`/api/files/${f.id}`} download>
            <Download size={15} />
            Download
          </a>
        </div>
      ))}
    </div>
  );
}
function ActivityView({ state }: { state: State }) {
  const [events, setEvents] = useState<
      {
        id: string;
        title: string;
        detail: string;
        type: string;
        created_at: string;
      }[]
    >([]),
    [digest, setDigest] = useState<{
      verifiedCount: number;
      outcomes: { id: string; title: string; evidence_count: number }[];
    } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api<typeof events>("/activity")
      .then(setEvents)
      .catch((e) => setError(e.message));
    api<typeof digest>("/digest/weekly")
      .then(setDigest)
      .catch(() => {});
  }, [state.tasks]);
  return error ? (
    <p className="form-error">{error}</p>
  ) : !events.length && !digest?.verifiedCount ? (
    <Empty
      icon={Activity}
      title="The story behind the work."
      text="Significant actions and outcomes appear here as your workers get things done."
    />
  ) : (
    <>
      {digest?.verifiedCount ? (
        <section className="settings-section">
          <h2>This week</h2>
          <p>
            {digest.verifiedCount} verified outcome
            {digest.verifiedCount === 1 ? "" : "s"} with persisted evidence.
          </p>
          <a className="text-button" href="/api/digest/weekly/receipt" download>
            <Download size={13} /> Download weekly receipt
          </a>
          {digest.outcomes.map((outcome) => (
            <div className="detail-pair" key={outcome.id}>
              <span>{outcome.evidence_count} checks</span>
              <strong>{outcome.title}</strong>
            </div>
          ))}
        </section>
      ) : null}
      <div className="activity-list">
        {events.map((e) => (
          <div key={e.id} className="activity-row">
            <span className="task-state-icon">
              <Activity size={17} />
            </span>
            <div>
              <strong>{e.title || "Workspace activity"}</strong>
              <p>{eventText(e.detail)}</p>
            </div>
            <time>
              {new Date(e.created_at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
        ))}
      </div>
    </>
  );
}
function SettingsView({ state, act, notify, refresh }: Props) {
  const [testing, setTesting] = useState(""),
    [result, setResult] = useState(""),
    [providerForm, setProviderForm] = useState(!!state.settings.compatible),
    [config, setConfig] = useState(
      state.settings.compatible || {
        name: "OpenAI",
        endpoint: "https://api.openai.com/v1",
        model: "",
      },
    ),
    [key, setKey] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [workspaceName, setWorkspaceName] = useState(state.settings.workspaceName),
    [mcpUrl, setMcpUrl] = useState(""),
    [mcpBusy, setMcpBusy] = useState(false),
    [mcpError, setMcpError] = useState(""),
    [localMcpCommand, setLocalMcpCommand] = useState(""),
    [localMcpArgs, setLocalMcpArgs] = useState("[]"),
    [localMcpBusy, setLocalMcpBusy] = useState(false),
    [localMcpError, setLocalMcpError] = useState(""),
    [mcpTool, setMcpTool] = useState<{
      connectionId: string;
      name: string;
      argumentsText: string;
      workspace: string;
      result: string;
      error: string;
    } | null>(null);
  const test = async (provider: string) => {
    setTesting(provider);
    setResult("");
    setError("");
    try {
      const r = await api<{ message: string }>("/providers/test", "POST", {
        provider,
      });
      setResult(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting("");
    }
  };
  return (
    <div className="workspace-page">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p>A workspace that works the way you do.</p>
        </div>
      </header>
      <div className="settings-content">
        <section className="settings-section">
          <h2>Make yourself at home</h2>
          <p>A few personal touches for your everyday work.</p>
          <div className="setting-row">
            <div>
              <strong>Appearance</strong>
              <small>Choose a comfortable view for your workspace.</small>
            </div>
            <div className="theme-picker">
              {[
                { id: "light", icon: Sun },
                { id: "dark", icon: Moon },
                { id: "system", icon: Monitor },
              ].map((t) => (
                <button
                  key={t.id}
                  className={state.settings.theme === t.id ? "selected" : ""}
                  onClick={() =>
                    act(() => api("/settings", "POST", { theme: t.id }))
                  }
                >
                  <t.icon size={14} />
                  {t.id[0].toUpperCase() + t.id.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>Chat background</strong>
              <small>Choose a quiet backdrop for conversations.</small>
            </div>
            <div className="theme-picker">
              {["classic", "paper", "plain"].map((wallpaper) => (
                <button
                  key={wallpaper}
                  className={
                    state.settings.wallpaper === wallpaper ? "selected" : ""
                  }
                  onClick={() =>
                    act(() => api("/settings", "POST", { wallpaper }))
                  }
                >
                  {wallpaper[0].toUpperCase() + wallpaper.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <form
            className="setting-row"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api("/settings", "POST", { workspaceName }));
            }}
          >
            <div>
              <strong>Workspace name</strong>
              <small>Something that feels like yours.</small>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <label className="field" style={{ margin: 0 }}>
                <input
                  aria-label="Workspace name"
                  maxLength={100}
                  required
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                />
              </label>
              <button className="secondary">Save</button>
            </div>
          </form>
        </section>
        <section className="settings-section">
          <h2>Engineering integrations</h2>
          <p>
            Connected tools supply scoped context and verification evidence.
            Roster keeps external writes behind its approval policy.
          </p>
          {state.integrations.map((integration) => {
            let capabilities: string[] = [];
            let risks: Record<string, string> = {};
            try {
              capabilities = JSON.parse(integration.capabilities_json || "[]");
              risks = JSON.parse(integration.risk_policy_json || "{}");
            } catch {
              // A malformed local record should not hide the integration controls.
            }
            return (
              <div className="provider-row" key={integration.id}>
                <span className="provider-logo">
                  <Code2 size={21} />
                </span>
                <div>
                  <strong>{integration.name}</strong>
                  <small>{integration.detail}</small>
                  <details>
                    <summary>Connection details</summary>
                    <small>Connection type: {integration.type}</small>
                    <small>
                      Capabilities:{" "}
                      {capabilities.length
                        ? capabilities.join(", ")
                        : "None discovered"}
                    </small>
                    <small>
                      Risk policy:{" "}
                      {Object.entries(risks)
                        .map(
                          ([risk, policy]) =>
                            `${risk.replaceAll("_", " ")}: ${policy.replaceAll("_", " ")}`,
                        )
                        .join(" · ") || "No policy available"}
                    </small>
                  </details>
                  <IntegrationScopeEditor
                    integrationId={integration.id}
                    scopeJson={integration.workspace_scope_json}
                    profiles={state.projectProfiles}
                    act={act}
                  />
                  <IntegrationTokenEditor
                    integration={integration}
                    act={act}
                    notify={notify}
                  />
                  <IntegrationReadPanel integration={integration} act={act} />
                  <SentryWatchEditor
                    integration={integration}
                    act={act}
                    notify={notify}
                  />
                </div>
                <span className="status-pill">
                  {statusLabel[integration.status] || integration.status}
                </span>
              </div>
            );
          })}
          <button
            className="text-button"
            onClick={() => act(() => api("/integrations/refresh", "POST", {}))}
          >
            <RefreshCw size={13} /> Refresh integrations
          </button>
        </section>
        {state.projectProfiles.length > 0 && (
          <section className="settings-section">
            <h2>Project environments</h2>
            <p>
              Roster detected these local setup recipes when you saved each
              project. Adjust them here before assigning isolated work.
            </p>
            {state.projectProfiles.map((profile) => (
              <ProjectEnvironmentEditor
                key={profile.workspace}
                profile={profile}
                act={act}
                notify={notify}
              />
            ))}
          </section>
        )}
        <section className="settings-section">
          <h2>MCP servers</h2>
          <p>
            Discover a remote Model Context Protocol server before connecting
            credentials. Roster does not send tokens during discovery.
          </p>
          <form
            className="setting-row"
            onSubmit={async (event) => {
              event.preventDefault();
              setMcpBusy(true);
              setMcpError("");
              try {
                await act(() => api("/mcp/discover", "POST", { url: mcpUrl }));
                setMcpUrl("");
                notify("MCP server discovery is complete.");
              } catch (e) {
                setMcpError((e as Error).message);
              } finally {
                setMcpBusy(false);
              }
            }}
          >
            <label className="field" style={{ flex: 1, margin: 0 }}>
              <span className="sr-only">MCP server URL</span>
              <input
                aria-label="MCP server URL"
                type="url"
                placeholder="https://example.com/mcp"
                required
                value={mcpUrl}
                onChange={(event) => setMcpUrl(event.target.value)}
              />
            </label>
            <button className="secondary" disabled={mcpBusy}>
              {mcpBusy ? "Discovering…" : "Discover server"}
            </button>
          </form>
          {mcpError && <p className="form-error">{mcpError}</p>}
          <details className="setting-row">
            <summary>Connect a local stdio server</summary>
            <form
              className="field"
              onSubmit={async (event) => {
                event.preventDefault();
                setLocalMcpBusy(true);
                setLocalMcpError("");
                try {
                  const args = JSON.parse(localMcpArgs);
                  if (
                    !Array.isArray(args) ||
                    args.some((arg) => typeof arg !== "string")
                  )
                    throw new Error(
                      "Local MCP arguments must be a JSON string array.",
                    );
                  await act(() =>
                    api("/mcp/discover-local", "POST", {
                      command: localMcpCommand,
                      args,
                    }),
                  );
                  setLocalMcpCommand("");
                  setLocalMcpArgs("[]");
                  notify("Local MCP discovery is complete.");
                } catch (error) {
                  setLocalMcpError((error as Error).message);
                } finally {
                  setLocalMcpBusy(false);
                }
              }}
            >
              <small>
                Roster starts this command directly without a shell. Connect
                only local tools you trust.
              </small>
              <input
                aria-label="Local MCP command"
                placeholder="npx"
                required
                value={localMcpCommand}
                onChange={(event) => setLocalMcpCommand(event.target.value)}
              />
              <textarea
                aria-label="Local MCP arguments"
                value={localMcpArgs}
                onChange={(event) => setLocalMcpArgs(event.target.value)}
              />
              <button className="secondary" disabled={localMcpBusy}>
                {localMcpBusy ? "Discovering…" : "Discover local server"}
              </button>
              {localMcpError && <p className="form-error">{localMcpError}</p>}
            </form>
          </details>
          {state.mcpConnections.map((connection) => {
            const tools = JSON.parse(connection.tools_json || "[]") as {
              name: string;
              description: string;
            }[];
            return (
              <div className="provider-row" key={connection.id}>
                <span className="provider-logo">
                  <Code2 size={21} />
                </span>
                <div>
                  <strong>{connection.server_name}</strong>
                  <small>
                    {connection.transport === "stdio"
                      ? "Local stdio"
                      : "Remote HTTP"}
                  </small>
                  <small>{connection.detail}</small>
                  {connection.transport === "remote" &&
                    connection.status === "authentication_required" && (
                      <button
                        className="text-button"
                        onClick={async () => {
                          try {
                            const response = await api<{
                              authorizationUrl: string;
                            }>(`/mcp/${connection.id}/authorize`, "POST", {});
                            window.open(
                              response.authorizationUrl,
                              "_blank",
                              "noopener,noreferrer",
                            );
                            await refresh();
                          } catch (error) {
                            notify((error as Error).message);
                          }
                        }}
                      >
                        Connect account
                      </button>
                    )}
                  {tools.length ? (
                    <details>
                      <summary>
                        {tools.length} tools in the local registry
                      </summary>
                      {tools.map((tool) => (
                        <button
                          className="text-button"
                          key={tool.name}
                          onClick={() =>
                            setMcpTool({
                              connectionId: connection.id,
                              name: tool.name,
                              argumentsText: "{}",
                              workspace:
                                workspaceScopes(
                                  connection.workspace_scope_json,
                                )[0] || "",
                              result: "",
                              error: "",
                            })
                          }
                        >
                          Run {tool.name}
                        </button>
                      ))}
                    </details>
                  ) : null}
                  <McpScopeEditor
                    connectionId={connection.id}
                    scopeJson={connection.workspace_scope_json}
                    profiles={state.projectProfiles}
                    act={act}
                  />
                </div>
                <span className="status-pill">
                  {statusLabel[connection.status] || connection.status}
                </span>
              </div>
            );
          })}
          {mcpTool && (
            <form
              className="field"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  const argumentsValue = JSON.parse(mcpTool.argumentsText);
                  if (
                    !argumentsValue ||
                    Array.isArray(argumentsValue) ||
                    typeof argumentsValue !== "object"
                  )
                    throw new Error("Tool arguments must be a JSON object.");
                  const response = await api<{ result: unknown }>(
                    `/mcp/${mcpTool.connectionId}/tools/call`,
                    "POST",
                    {
                      name: mcpTool.name,
                      arguments: argumentsValue,
                      workspace: mcpTool.workspace,
                    },
                  );
                  setMcpTool({
                    ...mcpTool,
                    result: JSON.stringify(response.result, null, 2),
                    error: "",
                  });
                } catch (error) {
                  setMcpTool({
                    ...mcpTool,
                    error: (error as Error).message,
                  });
                }
              }}
            >
              <strong>Run {mcpTool.name}</strong>
              <small>
                This sends a direct request to the selected MCP server. Use only
                arguments you intend to share with that server.
              </small>
              <textarea
                aria-label={`Arguments for ${mcpTool.name}`}
                value={mcpTool.argumentsText}
                onChange={(event) =>
                  setMcpTool({ ...mcpTool, argumentsText: event.target.value })
                }
              />
              {workspaceScopes(
                state.mcpConnections.find(
                  (connection) => connection.id === mcpTool.connectionId,
                )?.workspace_scope_json || "[]",
              ).length > 0 && (
                <label className="field">
                  Project access
                  <select
                    value={mcpTool.workspace}
                    onChange={(event) =>
                      setMcpTool({ ...mcpTool, workspace: event.target.value })
                    }
                  >
                    {workspaceScopes(
                      state.mcpConnections.find(
                        (connection) => connection.id === mcpTool.connectionId,
                      )?.workspace_scope_json || "[]",
                    ).map((scope) => (
                      <option key={scope} value={scope}>
                        {state.projectProfiles.find(
                          (profile) => profile.workspace === scope,
                        )?.name || scope}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button className="secondary">Run tool</button>
              <button
                className="text-button"
                type="button"
                onClick={() => setMcpTool(null)}
              >
                Close
              </button>
              {mcpTool.error && <p className="form-error">{mcpTool.error}</p>}
              {mcpTool.result && <pre>{mcpTool.result}</pre>}
            </form>
          )}
        </section>
        <section className="settings-section">
          <h2>AI connections</h2>
          <p>
            Your workers use these connections to respond and get things done.
          </p>
          {state.providers.map((provider) => (
            <div key={provider.id}>
              <div className="provider-row">
                <span className="provider-logo">
                  <Code2 size={21} />
                </span>
                <div>
                  <strong>{provider.name}</strong>
                  <small>{provider.version || provider.detail}</small>
                </div>
                <span className="status-pill">
                  {statusLabel[provider.status] || provider.status}
                </span>
                {["connected", "configured", "available"].includes(
                  provider.status,
                ) && (
                  <button
                    className="secondary"
                    disabled={!!testing}
                    onClick={() => test(provider.id)}
                  >
                    {testing === provider.id ? "Testing…" : "Test"}
                  </button>
                )}
                {provider.id === "compatible" && (
                  <button
                    className="secondary"
                    onClick={() => setProviderForm(!providerForm)}
                  >
                    {state.settings.compatible ? "Edit" : "Connect"}
                  </button>
                )}
              </div>
              {provider.id === "codex" && provider.status !== "connected" && (
                <div className="provider-detail">
                  Sign in once with the official Codex CLI, then refresh
                  connections.
                  <br />
                  <code>npx codex login</code>
                </div>
              )}
              {provider.id === "claude" &&
                provider.status === "unavailable" && (
                  <div className="provider-detail">
                    Install and sign in to Claude Code, then refresh
                    connections.
                  </div>
                )}
            </div>
          ))}
          <button
            className="text-button"
            onClick={() => act(() => api("/providers/detect", "POST", {}))}
          >
            <RefreshCw size={13} /> Refresh connections
          </button>
          {result && (
            <div className="provider-detail" role="status">
              {result}
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {providerForm && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setSaving(true);
                setError("");
                try {
                  await api("/settings", "POST", {
                    compatible: config,
                    ...(key ? { apiKey: key } : {}),
                  });
                  setKey("");
                  notify("Connection saved");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              <div className="form-body">
                <label className="field">
                  Connection name
                  <input
                    required
                    value={config.name}
                    onChange={(e) =>
                      setConfig({ ...config, name: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  API endpoint
                  <input
                    type="url"
                    required
                    placeholder="https://api.openai.com/v1"
                    value={config.endpoint}
                    onChange={(e) =>
                      setConfig({ ...config, endpoint: e.target.value })
                    }
                  />
                  <small>
                    OpenAI-compatible endpoints, including local Ollama at
                    http://127.0.0.1:11434/v1.
                  </small>
                </label>
                <label className="field">
                  Model
                  <input
                    required
                    placeholder="Your provider’s model ID"
                    value={config.model}
                    onChange={(e) =>
                      setConfig({ ...config, model: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={
                      state.settings.hasKey
                        ? "A key is already configured"
                        : "Optional for local providers"
                    }
                  />
                  <small>
                    {state.settings.canSaveKey
                      ? state.settings.keyStorage === "encrypted"
                        ? "Encrypted on this device. Never returned to the browser."
                        : "Kept in server memory for this session. Set OPENAI_API_KEY to reconnect OpenAI after a restart."
                      : "For this web session, set OPENAI_API_KEY before starting Roster. Keys cannot be saved here yet."}
                  </small>
                </label>
              </div>
              <div className="form-actions">
                {state.settings.compatible && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      act(() => api("/settings", "POST", { compatible: null }))
                    }
                  >
                    Disconnect
                  </button>
                )}
                <button className="primary" disabled={saving}>
                  {saving ? "Saving…" : "Save connection"}
                </button>
              </div>
            </form>
          )}
        </section>
        <section className="settings-section">
          <h2>Work & privacy</h2>
          <p>Keep your team focused and your work close.</p>
          <div className="setting-row">
            <div>
              <strong>Parallel workers</strong>
              <small>
                Coding tasks use isolated Git workspaces when the project is
                ready for them.
              </small>
            </div>
            <select
              aria-label="Parallel worker limit"
              value={state.settings.parallelLimit}
              onChange={(e) =>
                act(() =>
                  api("/settings", "POST", {
                    parallelLimit: Number(e.target.value),
                  }),
                )
              }
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div>
              <strong>Saved on your machine</strong>
              <small>
                {state.settings.directory}
                <br />
                Messages are sent to the selected AI provider. No external
                analytics.
              </small>
            </div>
            <Folder size={20} />
          </div>
          <div className="setting-row">
            <div>
              <strong>Changes stay under your control</strong>
              <small>
                Each worker follows the project access level in their profile.
                External side effects still appear for approval.
              </small>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>Repair attempts</strong>
              <small>
                Roster asks you after this many review and repair cycles.
              </small>
            </div>
            <select
              aria-label="Repair attempt limit"
              value={state.settings.repairLimit}
              onChange={(e) =>
                act(() =>
                  api("/settings", "POST", {
                    repairLimit: Number(e.target.value),
                  }),
                )
              }
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          {window.rosterDesktop && (
            <div className="setting-row">
              <div>
                <strong>Desktop diagnostics</strong>
                <small>
                  Logs help troubleshoot the local desktop runtime. Diagnostics
                  include versions and paths, never provider keys or chat text.
                </small>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => void window.rosterDesktop!.openLogs()}
                >
                  Open logs
                </button>
                <button
                  type="button"
                  className="secondary compact"
                  onClick={async () => {
                    await window.rosterDesktop!.copyDiagnostics();
                    notify("Diagnostics copied.");
                  }}
                >
                  Copy diagnostics
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
