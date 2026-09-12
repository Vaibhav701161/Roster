import { useEffect, useState, useRef } from "react";
import {
  X,
  Folder,
  Plus,
  MessageCircle,
  Search,
  CheckCheck,
  ArrowUpRight,
  Trash2,
  PenLine,
} from "lucide-react";
import { Avatar, IconButton, Modal, templates } from "./main";
import { api } from "./api";
import {
  Agent,
  Team,
  State,
  TaskDetail,
  Message,
  statusLabel,
  activeStatuses,
} from "./types";
declare global {
  interface Window {
    rosterDesktop?: {
      chooseFolder: () => Promise<string | null>;
      openLogs: () => Promise<string>;
      copyDiagnostics: () => Promise<boolean>;
      onOpenSettings: (callback: () => void) => () => void;
    };
  }
}
const defaults = {
  name: "",
  role: "",
  description: "",
  instructions: "",
  color: "green",
  provider: "auto",
  permission_level: "standard" as const,
  workspace: "",
  benched: false,
};
export function WorkerModal({
  value,
  onClose,
  onSave,
}: {
  value: Partial<Agent>;
  onClose: () => void;
  onSave: (value: unknown) => Promise<void>;
}) {
  const [form, setForm] = useState({ ...defaults, ...value }),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const change = (key: string, value: unknown) =>
    setForm((f) => ({ ...f, [key]: value }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSave(form);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={value.id ? "Edit worker" : "Add to your roster"}
      onClose={onClose}
    >
      <form onSubmit={save}>
        <div className="form-body">
          <p>
            Give your worker a name and a purpose. You can fine-tune the rest
            whenever you like.
          </p>
          {!value.id && (
            <div className="template-select">
              {templates.map((t) => (
                <button
                  type="button"
                  key={t.role}
                  className={form.role === t.role ? "selected" : ""}
                  onClick={() => setForm((f) => ({ ...f, ...t }))}
                >
                  {t.role}
                </button>
              ))}
            </div>
          )}
          <div className="avatar-picker">
            <Avatar name={form.name || "R"} color={form.color} size="large" />
            <div>
              <p className="muted-note" style={{ margin: "0 0 10px" }}>
                A familiar face in your chat list
              </p>
              <div className="color-options">
                {["green", "blue", "purple", "peach", "gold"].map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`${c} avatar`}
                    className={`${c} ${form.color === c ? "selected" : ""}`}
                    onClick={() => change("color", c)}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="form-row">
            <label className="field">
              Name
              <input
                autoFocus
                required
                maxLength={100}
                placeholder="e.g. Alex"
                value={form.name}
                onChange={(e) => change("name", e.target.value)}
              />
            </label>
            <label className="field">
              Role
              <input
                required
                maxLength={100}
                placeholder="e.g. Software Engineer"
                value={form.role}
                onChange={(e) => change("role", e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            What should they be great at?
            <textarea
              maxLength={3000}
              placeholder="Describe how this worker can help you…"
              value={form.description}
              onChange={(e) => change("description", e.target.value)}
            />
          </label>
          <label className="field">
            Workspace folder{" "}
            <span className="folder-input">
              <input
                placeholder="Optional · full path to a project folder"
                value={form.workspace}
                onChange={(e) => change("workspace", e.target.value)}
              />
              {window.rosterDesktop && (
                <button
                  type="button"
                  aria-label="Choose workspace folder"
                  onClick={async () => {
                    const p = await window.rosterDesktop!.chooseFolder();
                    if (p) change("workspace", p);
                  }}
                >
                  <Folder size={17} />
                </button>
              )}
            </span>
            <small>
              Attach a folder for project work. Leave empty for general
              assistance.
            </small>
          </label>
          <details className="advanced">
            <summary>Advanced settings</summary>
            <label className="field">
              Runtime
              <select
                value={form.provider}
                onChange={(e) => change("provider", e.target.value)}
              >
                <option value="auto">Automatic · recommended</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
                <option value="compatible">OpenAI-compatible</option>
              </select>
            </label>
            <label className="field">
              Project access
              <select
                value={form.permission_level}
                onChange={(e) => change("permission_level", e.target.value)}
              >
                <option value="read_only">Read only</option>
                <option value="standard">Standard</option>
                <option value="autonomous">Autonomous</option>
              </select>
              <small>
                Standard work can edit the attached project and run normal
                development commands. External side effects still need approval.
              </small>
            </label>
            <label className="field">
              Persistent instructions
              <textarea
                placeholder="Preferences, working style, and things to remember…"
                value={form.instructions}
                onChange={(e) => change("instructions", e.target.value)}
                maxLength={8000}
              />
            </label>
            <p className="muted-note">
              Project access starts read-only. The runtime can request approval
              for changes in chat.
            </p>
          </details>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            {saving ? "Saving…" : value.id ? "Save changes" : "Add to roster"}
            <Plus size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function TeamModal({
  value,
  state,
  onClose,
  onSave,
}: {
  value: Partial<Team>;
  state: State;
  onClose: () => void;
  onSave: (value: unknown) => Promise<void>;
}) {
  const [form, setForm] = useState({
      name: "",
      objective: "",
      workspace: "",
      members: [] as string[],
      ...value,
    }),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(form);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={value.id ? "Edit team" : "Bring your team together"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <p>
            A shared conversation, a clear purpose, and the right people for the
            job.
          </p>
          <label className="field">
            Team name
            <input
              required
              autoFocus
              maxLength={100}
              placeholder="e.g. Product team"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field">
            What are you working toward?
            <textarea
              maxLength={4000}
              placeholder="Give your team a shared objective…"
              value={form.objective}
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
            />
          </label>
          <label className="field">
            Shared workspace
            <input
              placeholder="Optional · full path to a project folder"
              value={form.workspace}
              onChange={(e) => setForm({ ...form, workspace: e.target.value })}
            />
            <small>
              A shared folder takes precedence over individual worker folders.
            </small>
          </label>
          <span className="field">Choose your workers</span>
          <div className="member-picker">
            {state.agents.map((a) => (
              <label className="member-option" key={a.id}>
                <input
                  type="checkbox"
                  checked={form.members.includes(a.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      members: e.target.checked
                        ? [...form.members, a.id]
                        : form.members.filter((id) => id !== a.id),
                    })
                  }
                />
                <Avatar name={a.name} color={a.color} size="small" />
                <span>
                  <strong>{a.name}</strong>
                  <small>
                    {a.role}
                    {a.benched ? " · Benched" : ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {!state.agents.length && (
            <p className="muted-note">
              Add at least one worker to your roster before creating a team.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={saving || !form.members.length}>
            {saving ? "Saving…" : value.id ? "Save team" : "Create team"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function ProfilePanel({
  agent,
  team,
  state,
  onClose,
  onEdit,
}: {
  agent?: Agent;
  team?: Team;
  state: State;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [memory, setMemory] = useState(""),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const entity = agent || team;
  if (!entity)
    return (
      <aside className="drawer">
        <header className="drawer-header">
          <h2>Chat history</h2>
          <IconButton label="Close details" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="drawer-section">
          <p>This worker has been removed. Your conversation is preserved.</p>
        </div>
      </aside>
    );
  const saveMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await api(
        editing ? `/memories/${editing}` : "/memories",
        editing ? "PUT" : "POST",
        editing ? { content: memory } : { scopeId: entity.id, content: memory },
      );
      setMemory("");
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <aside className="drawer" aria-label="Contact details">
      <header className="drawer-header">
        <h2>{team ? "Team info" : "Contact info"}</h2>
        <IconButton label="Close details" onClick={onClose}>
          <X size={19} />
        </IconButton>
      </header>
      <div className="profile-hero">
        <Avatar
          name={entity.name}
          color={agent?.color}
          team={!!team}
          size="large"
        />
        <h2>{entity.name}</h2>
        <p>{agent?.role || `${team?.members.length} workers`}</p>
        {agent && (
          <span className={`status-pill ${agent.status}`}>
            <span className="tiny-dot" />
            {statusLabel[agent.status]}
          </span>
        )}
        <button className="secondary" onClick={onEdit}>
          <PenLine size={14} />
          Edit {team ? "team" : "worker"}
        </button>
      </div>
      <section className="drawer-section">
        <h3>{team ? "Shared objective" : "About"}</h3>
        <p>
          {agent?.description || team?.objective || "No description added yet."}
        </p>
        {agent && (
          <div className="detail-pair">
            <span>Runtime</span>
            <strong>
              {agent.provider === "auto"
                ? "Automatic"
                : agent.provider === "codex"
                  ? "Codex"
                  : agent.provider === "claude"
                    ? "Claude Code"
                    : "OpenAI-compatible"}
            </strong>
          </div>
        )}
        <div className="detail-pair">
          <span>Workspace</span>
          <strong>{entity.workspace || "General assistance"}</strong>
        </div>
      </section>
      {team && (
        <section className="drawer-section">
          <h3>Team members</h3>
          {team.members.map((id) => {
            const a = state.agents.find((a) => a.id === id);
            return a ? (
              <div className="member-option" key={id}>
                <Avatar name={a.name} color={a.color} size="small" />
                <span>
                  <strong>{a.name}</strong>
                  <small>
                    {a.role} · {statusLabel[a.status]}
                  </small>
                </span>
              </div>
            ) : null;
          })}
        </section>
      )}
      <section className="drawer-section">
        <h3>{team ? "Decisions & memory" : "Memory"}</h3>
        <p className="muted-note" style={{ margin: "0 0 15px" }}>
          Save useful context for future conversations.
        </p>
        {state.memories
          .filter((m) => m.scope_id === entity.id)
          .map((m) => (
            <div className="memory-item" key={m.id}>
              <p>{m.content}</p>
              <div>
                <button
                  onClick={() => {
                    setMemory(m.content);
                    setEditing(m.id);
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() =>
                    api(`/memories/${m.id}`, "DELETE", {}).catch((e) =>
                      setError(e.message),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        <form onSubmit={saveMemory}>
          <label className="field">
            <textarea
              aria-label="Memory"
              placeholder="A preference, decision, or useful fact…"
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              required
              maxLength={4000}
            />
          </label>
          <button className="secondary" disabled={pending || !memory.trim()}>
            {editing ? "Save memory" : "Add memory"}
          </button>
          {editing && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setEditing(null);
                setMemory("");
              }}
            >
              Cancel
            </button>
          )}
        </form>
        {error && <p className="form-error">{error}</p>}
      </section>
    </aside>
  );
}
export function eventText(detail: string) {
  try {
    const data = JSON.parse(detail);
    return data.detail || data.evidence || JSON.stringify(data, null, 2);
  } catch {
    return detail;
  }
}
export function TaskPanel({
  id,
  state,
  onClose,
  act,
}: {
  id: string;
  state: State;
  onClose: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null),
    [inspection, setInspection] = useState<{
      available: boolean;
      reason?: string;
      files?: { status: string; path: string }[];
      diff?: string;
      truncated?: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [evidence, setEvidence] = useState(""),
    [verifying, setVerifying] = useState(false),
    [criterion, setCriterion] = useState(""),
    [criterionType, setCriterionType] = useState("manual"),
    [recordingCriterion, setRecordingCriterion] = useState<string | null>(null),
    [criterionEvidence, setCriterionEvidence] = useState("");
  const task =
    detail?.task.id === id ? detail.task : state.tasks.find((t) => t.id === id);
  useEffect(() => {
    let cancelled = false;
    api<TaskDetail>(`/tasks/${id}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => setError(e.message));
    api(`/tasks/${id}/inspection`)
      .then((result) => {
        if (!cancelled) setInspection(result as typeof inspection);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, state.tasks]);
  return (
    <aside className="drawer" aria-label="Work details">
      <header className="drawer-header">
        <h2>Work details</h2>
        <IconButton label="Close work details" onClick={onClose}>
          <X size={19} />
        </IconButton>
      </header>
      {task && (
        <>
          <section className="drawer-section" style={{ borderTop: 0 }}>
            <h2 className="task-drawer-title">{task.title}</h2>
            <span className={`status-pill ${task.status}`}>
              {statusLabel[task.status]}
            </span>
            <div className="detail-pair">
              <span>Assigned to</span>
              <strong>
                {state.agents.find((a) => a.id === task.owner_id)?.name ||
                  "Removed worker"}
              </strong>
            </div>
            <div className="detail-pair">
              <span>Verification</span>
              <strong>{statusLabel[task.verification]}</strong>
            </div>
            {task.error && <p className="form-error">{task.error}</p>}
            {activeStatuses.includes(task.status) && (
              <button
                className="secondary"
                onClick={() =>
                  act(() => api(`/tasks/${id}/cancel`, "POST", {}))
                }
              >
                Stop this work
              </button>
            )}
            {["failed", "cancelled", "interrupted"].includes(task.status) && (
              <button
                className="primary"
                onClick={() => act(() => api(`/tasks/${id}/retry`, "POST", {}))}
              >
                {task.status === "interrupted" ? "Resume work" : "Retry work"}
              </button>
            )}
            {task.status === "completed" &&
              task.verification !== "verified" && (
                <button
                  className="secondary"
                  onClick={() => setVerifying(!verifying)}
                >
                  <CheckCheck size={15} />
                  Record your verification
                </button>
              )}
            {verifying && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await act(() =>
                    api(`/tasks/${id}/verify`, "POST", { evidence }),
                  );
                  setVerifying(false);
                }}
              >
                <label className="field" style={{ marginTop: 15 }}>
                  What did you check?
                  <textarea
                    required
                    minLength={10}
                    maxLength={3000}
                    placeholder="Describe the checks you ran and their results."
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                  />
                  <small>
                    This records your verification with its supporting evidence.
                  </small>
                </label>
                <button className="primary">Save verification</button>
              </form>
            )}
          </section>
          {detail?.outcome && (
            <section className="drawer-section">
              <h3>Done when</h3>
              <p>{detail.outcome.goal}</p>
              {detail.criteria.map((criterion) => (
                <div className="detail-pair" key={criterion.id}>
                  <span>
                    {criterion.status === "pass" ? "Checked" : "Pending"}
                  </span>
                  <strong>{criterion.description}</strong>
                  {criterion.status === "pending" && (
                    <button
                      className="text-button"
                      onClick={() => setRecordingCriterion(criterion.id)}
                    >
                      Record
                    </button>
                  )}
                </div>
              ))}
              {recordingCriterion && (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    await act(() =>
                      api(`/criteria/${recordingCriterion}/record`, "POST", {
                        status: "pass",
                        evidence: criterionEvidence,
                      }),
                    );
                    setRecordingCriterion(null);
                    setCriterionEvidence("");
                    setDetail(await api<TaskDetail>(`/tasks/${id}`));
                  }}
                >
                  <label className="field">
                    What supports this check?
                    <textarea
                      required
                      minLength={3}
                      maxLength={3000}
                      value={criterionEvidence}
                      onChange={(event) =>
                        setCriterionEvidence(event.target.value)
                      }
                      placeholder="For example, npm test completed successfully"
                    />
                  </label>
                  <button className="primary">Record passed check</button>
                </form>
              )}
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!detail.outcome) return;
                  await act(() =>
                    api(`/outcomes/${detail.outcome!.id}/criteria`, "POST", {
                      type: criterionType,
                      description: criterion,
                    }),
                  );
                  setCriterion("");
                  const updated = await api<TaskDetail>(`/tasks/${id}`);
                  setDetail(updated);
                }}
              >
                <label className="field" style={{ marginTop: 14 }}>
                  Add a completion check
                  <input
                    value={criterion}
                    required
                    minLength={3}
                    maxLength={1000}
                    onChange={(event) => setCriterion(event.target.value)}
                    placeholder="For example, the login test passes"
                  />
                </label>
                <select
                  aria-label="Completion check type"
                  value={criterionType}
                  onChange={(event) => setCriterionType(event.target.value)}
                >
                  {[
                    "manual",
                    "command",
                    "test",
                    "build",
                    "review",
                    "browser",
                    "github_ci",
                    "deployment",
                    "sentry",
                    "external_tool",
                  ].map((type) => (
                    <option key={type} value={type}>
                      {type.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
                <button className="secondary" style={{ marginTop: 8 }}>
                  Add check
                </button>
              </form>
            </section>
          )}
          {detail?.review && (
            <section className="drawer-section">
              <h3>Review: {detail.review.verdict.replaceAll("_", " ")}</h3>
              <p>{detail.review.summary}</p>
            </section>
          )}
          {detail?.evidence.length ? (
            <section className="drawer-section">
              <h3>Evidence</h3>
              {detail.evidence.map((item) => (
                <div className="detail-pair" key={item.id}>
                  <span>{item.status}</span>
                  <strong>{item.summary}</strong>
                </div>
              ))}
            </section>
          ) : null}
          {detail?.receipt && (
            <section className="drawer-section">
              <h3>Work receipt</h3>
              <pre className="work-diff">{detail.receipt.content}</pre>
            </section>
          )}
          {detail?.dependencies.length ? (
            <section className="drawer-section">
              <h3>Earlier work</h3>
              {detail.dependencies.map((d) => (
                <div key={d.id}>
                  <p>{d.title}</p>
                  <small className="subtle">{statusLabel[d.status]}</small>
                </div>
              ))}
            </section>
          ) : null}
          {inspection?.available && (
            <section className="drawer-section">
              <h3>Files changed · {inspection.files?.length || 0}</h3>
              {inspection.files?.map((file) => (
                <div className="detail-pair" key={file.path}>
                  <span>{file.status}</span>
                  <strong>{file.path}</strong>
                </div>
              ))}
              {inspection.diff ? (
                <>
                  <h3 style={{ marginTop: 22 }}>Diff</h3>
                  <pre className="work-diff">{inspection.diff}</pre>
                  {inspection.truncated && (
                    <p className="muted-note">
                      Showing the first 500 KB of this diff.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted-note">
                  No unstaged Git diff is available yet.
                </p>
              )}
            </section>
          )}
          <section className="drawer-section">
            <h3>Activity</h3>
            <div className="timeline">
              {detail?.events.map((e) => (
                <div key={e.id}>
                  <time>{new Date(e.created_at).toLocaleTimeString()}</time>
                  <p>{eventText(e.detail)}</p>
                </div>
              ))}
            </div>
            {!detail && !error && <p>Opening saved activity…</p>}
            {error && <p className="form-error">{error}</p>}
          </section>
          {task.result && (
            <section className="drawer-section">
              <h3>Result</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{task.result}</p>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
export function SearchModal({
  state,
  onClose,
  onOpen,
}: {
  state: State;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState(""),
    [results, setResults] = useState<(Message & { name: string })[]>([]),
    [error, setError] = useState(""),
    [searching, setSearching] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(
      () =>
        api<(Message & { name: string })[]>(
          "/search?q=" + encodeURIComponent(q),
        )
          .then((r) => {
            if (!cancelled) setResults(r);
          })
          .catch((e) => {
            if (!cancelled) setError(e.message);
          })
          .finally(() => {
            if (!cancelled) setSearching(false);
          }),
      180,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);
  const chats = state.conversations.filter((c) =>
    c.name.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <Modal title="Find a conversation" onClose={onClose} wide>
      <div className="search-modal-input">
        <Search size={19} />
        <input
          autoFocus
          placeholder="Search people, teams, and messages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search your workspace"
        />
      </div>
      <div className="search-results">
        {chats.map((c) => (
          <button key={c.id} onClick={() => onOpen(c.id)}>
            <Avatar name={c.name} team={!!c.team_id} />
            <span>
              <strong>{c.name}</strong>
              <small>{c.preview || "Start a conversation"}</small>
            </span>
          </button>
        ))}
        {results.map((m) => (
          <button key={m.id} onClick={() => onOpen(m.conversation_id)}>
            <MessageCircle size={19} />
            <span>
              <strong>{m.name}</strong>
              <small>{m.content}</small>
            </span>
          </button>
        ))}
        {!chats.length && !results.length && (
          <p>
            {searching
              ? "Searching saved messages…"
              : q
                ? "No matches. Try a different word or name."
                : "Your conversations will appear here."}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
