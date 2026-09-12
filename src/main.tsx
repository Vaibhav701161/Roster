import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
} from "react";
import { createRoot } from "react-dom/client";
import {
  MessageCircle,
  Users,
  UserRound,
  CheckCheck,
  Folder,
  Activity,
  Settings as SettingsIcon,
  Plus,
  Search,
  ArrowUpRight,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  MoreHorizontal,
  Pin,
  Archive,
  Send,
  Paperclip,
  Smile,
  X,
  Check,
  Code2,
  ScanSearch,
  PenLine,
  ShieldCheck,
  LockKeyhole,
  Square,
  AlertCircle,
  RefreshCw,
  Sun,
  Moon,
  Command,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { api } from "./api";
import { registerRosterTools } from "./webmcp";
import {
  State,
  Agent,
  Team,
  Conversation,
  Message,
  Task,
  Attachment,
  activeStatuses,
  statusLabel,
} from "./types";
import "./style.css";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/dm-sans/latin-700.css";
const Markdown = lazy(() => import("./markdown"));
type View =
  | "Chats"
  | "Roster"
  | "Teams"
  | "Work"
  | "Needs You"
  | "Files"
  | "Activity"
  | "Settings";
export const templates = [
  {
    name: "Alex",
    role: "Software Engineer",
    description:
      "Builds thoughtful software, fixes bugs, and verifies changes.",
    color: "green",
    icon: Code2,
  },
  {
    name: "Maya",
    role: "Research Analyst",
    description:
      "Finds the facts, connects the dots, and brings you clear answers.",
    color: "blue",
    icon: ScanSearch,
  },
  {
    name: "Sam",
    role: "QA / Reviewer",
    description: "Independently reviews work and catches what others miss.",
    color: "purple",
    icon: ShieldCheck,
  },
  {
    name: "Nora",
    role: "Executive Assistant",
    description: "Organizes information and helps you stay one step ahead.",
    color: "peach",
    icon: PenLine,
  },
];
export function Mark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect x="8" y="6" width="84" height="70" rx="22" fill="currentColor" />
      <path
        d="M22 76H34C32 86 22 94 10 96C18 90 22 84 22 76Z"
        fill="currentColor"
      />
      <g fill="var(--mark-lines, #fff)">
        <rect x="22" y="22" width="52" height="8" rx="4" />
        <rect x="22" y="36" width="40" height="8" rx="4" />
        <rect x="22" y="50" width="28" height="8" rx="4" />
      </g>
    </svg>
  );
}
export function Avatar({
  name,
  color = "green",
  team = false,
  size = "",
  status,
  members = [],
}: {
  name: string;
  color?: string;
  team?: boolean;
  size?: string;
  status?: string;
  members?: { name: string; color?: string; status?: string }[];
}) {
  const people = members.slice(0, 4);
  return (
    <span
      className={`avatar ${color} ${size} ${people.length ? "composite" : ""}`}
    >
      {people.length ? (
        <span className="avatar-stack" aria-label={`${name} team members`}>
          {people.map((member) => (
            <i
              className={`avatar-mini ${member.color || "green"}`}
              key={member.name}
              title={member.name}
            >
              {member.name
                .split(" ")
                .map((part) => part[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </i>
          ))}
        </span>
      ) : team ? (
        <Users size={size === "large" ? 34 : 21} />
      ) : (
        name
          .split(" ")
          .map((n) => n[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()
      )}
      {status && <i className={`presence ${status}`} />}
    </span>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  className = "",
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          const b = ref.current.getBoundingClientRect();
          if (
            e.clientX < b.left ||
            e.clientX > b.right ||
            e.clientY < b.top ||
            e.clientY > b.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2>{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}
const time = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export function App() {
  const [state, setState] = useState<State | null>(null),
    [view, setView] = useState<View>("Chats"),
    [selected, setSelected] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("All"),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(true),
    [messages, setMessages] = useState<Message[]>([]),
    [hasOlder, setHasOlder] = useState(false),
    [loadingOlder, setLoadingOlder] = useState(false),
    [draft, setDraft] = useState(""),
    [sending, setSending] = useState(false),
    [worker, setWorker] = useState<Partial<Agent> | null>(null),
    [team, setTeam] = useState<Partial<Team> | null>(null),
    [profile, setProfile] = useState(false),
    [taskId, setTaskId] = useState<string | null>(null),
    [reply, setReply] = useState<Message | null>(null),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [searchOpen, setSearchOpen] = useState(false),
    [menu, setMenu] = useState(false),
    [emoji, setEmoji] = useState(false),
    [toast, setToast] = useState("");
  const selectedRef = useRef(selected);
  const stateRef = useRef(state);
  stateRef.current = state;
  selectedRef.current = selected;
  const scroll = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    follow = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const data = await api<State>("/state");
      setState(data);
      setConnected(true);
      if (selectedRef.current) {
        const conversationId = selectedRef.current;
        const m = await api<Message[]>(
          `/conversations/${conversationId}/messages`,
        );
        if (selectedRef.current === conversationId)
          setMessages((previous) => {
            const latest = m.map((saved) => {
              const live = previous.find((x) => x.id === saved.id);
              return saved.status === "streaming" &&
                live &&
                live.content.length > saved.content.length
                ? { ...saved, content: live.content }
                : saved;
            });
            const ids = new Set(latest.map((x) => x.id));
            return [
              ...previous.filter(
                (x) => x.conversation_id === conversationId && !ids.has(x.id),
              ),
              ...latest,
            ];
          });
      }
    } catch {
      setConnected(false);
    }
  }, []);
  useEffect(
    () =>
      registerRosterTools({
        read: () => ({
          workers:
            stateRef.current?.agents.map(({ id, name, role, status }) => ({
              id,
              name,
              role,
              status,
            })) || [],
        }),
        create: async (name, role) => {
          const result = await api<{ id: string; conversationId: string }>(
            "/agents",
            "POST",
            { name, role },
          );
          await refresh();
          setView("Chats");
          setSelected(result.conversationId);
          return result;
        },
        open: (id) => {
          if (!stateRef.current?.conversations.some((c) => c.id === id))
            throw new Error("Conversation not found.");
          setView("Chats");
          setSelected(id);
          return { conversationId: id };
        },
      }),
    [refresh],
  );
  useEffect(() => {
    refresh();
    const events = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    events.addEventListener("connected", () => {
      refresh();
    });
    events.addEventListener("state.changed", () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 100);
    });
    events.addEventListener("message.delta", (event) => {
      const { id, content } = JSON.parse((event as MessageEvent).data);
      setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, content } : m)));
    });
    events.onerror = () => setConnected(false);
    return () => {
      events.close();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    api<Message[]>(`/conversations/${selected}/messages`)
      .then((m) => {
        if (!cancelled) {
          setMessages(m);
          setHasOlder(m.length === 100);
        }
      })
      .catch((e) => setError(e.message));
    api(`/conversations/${selected}`, "PATCH", { read: true }).catch(() => {});
    follow.current = true;
    setReply(null);
    setAttachments([]);
    setDraft("");
    setMenu(false);
    return () => {
      cancelled = true;
    };
  }, [selected]);
  const newestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (selected && newestMessageId && view === "Chats" && document.hasFocus())
      api(`/conversations/${selected}`, "PATCH", { read: true }).catch(
        () => {},
      );
  }, [selected, newestMessageId, view]);
  async function loadOlder() {
    if (!selected || !messages[0] || loadingOlder) return;
    const conversationId = selected;
    setLoadingOlder(true);
    follow.current = false;
    try {
      const old = await api<Message[]>(
        `/conversations/${selected}/messages?before=${messages[0].id}`,
      );
      if (selectedRef.current === conversationId) {
        const height = scroll.current?.scrollHeight || 0;
        setMessages((m) => [...old, ...m]);
        setHasOlder(old.length === 100);
        requestAnimationFrame(() => {
          if (scroll.current)
            scroll.current.scrollTop = scroll.current.scrollHeight - height;
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, state?.tasks]);
  useEffect(() => {
    if (!state) return;
    const theme = state.settings.theme;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state?.settings.theme]);
  useEffect(() => {
    if (!window.rosterDesktop) return;
    return window.rosterDesktop.onOpenSettings(() => setView("Settings"));
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setWorker({});
      }
      if (e.key === "Escape") {
        setProfile(false);
        setTaskId(null);
        setMenu(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 3200);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openChat = (id: string) => {
    setSelected(id);
    setView("Chats");
    setProfile(false);
    setTaskId(null);
  };
  const notify = (text: string) => setToast(text);
  const conv = state?.conversations.find((c) => c.id === selected),
    agent = state?.agents.find((a) => a.id === conv?.agent_id),
    currentTeam = state?.teams.find((t) => t.id === conv?.team_id);
  const busy =
    !!state &&
    (state.planning.includes(selected || "") ||
      state.tasks.some(
        (t) =>
          t.conversation_id === selected && activeStatuses.includes(t.status),
      ));
  async function send() {
    if (!draft.trim() || !selected || sending) return;
    setSending(true);
    try {
      await api(`/conversations/${selected}/messages`, "POST", {
        content: draft,
        replyTo: reply?.id,
        attachments,
      });
      setDraft("");
      setAttachments([]);
      setReply(null);
      follow.current = true;
      await refresh();
      input.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function attach(list: FileList | null) {
    if (!list) return;
    try {
      const files = Array.from(list);
      if (files.length + attachments.length > 5)
        throw new Error("Attach up to five text files per message.");
      const accepted: Attachment[] = [];
      for (const f of files) {
        if (f.size > 200000)
          throw new Error(
            `${f.name} exceeds the 200 KB text attachment limit.`,
          );
        const content = await f.text();
        if (content.includes("\u0000") || content.includes("\uFFFD"))
          throw new Error(
            "Attach readable text or source files. Binary documents are not supported yet.",
          );
        accepted.push({ name: f.name, content });
      }
      setAttachments((a) => [...a, ...accepted]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  if (!state)
    return (
      <div className="boot">
        <Mark size={62} />
        <h1>roster</h1>
        <p>
          {connected
            ? "Opening your workspace…"
            : "The local service is unavailable."}
        </p>
        {!connected && (
          <button className="primary" onClick={refresh}>
            Try again
          </button>
        )}
      </div>
    );
  const nav = [
    { name: "Chats", icon: MessageCircle },
    { name: "Roster", icon: UserRound },
    { name: "Teams", icon: Users },
    { name: "Work", icon: CheckCheck },
    { name: "Needs You", icon: AlertCircle },
    { name: "Files", icon: Folder },
    { name: "Activity", icon: Activity },
  ] as const;
  const needsYou = state.needsYou.length;
  const conversations = state.conversations.filter(
    (c) =>
      (filter === "Archived" ? c.archived : !c.archived) &&
      (filter !== "Unread" || c.unread > 0) &&
      (filter !== "Teams" || c.team_id) &&
      (filter !== "Working" ||
        state.tasks.some(
          (t) =>
            t.conversation_id === c.id && activeStatuses.includes(t.status),
        )) &&
      c.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className={`app ${view === "Chats" && selected ? "chat-selected" : ""}`}
    >
      <nav className="nav">
        <button
          className="brand"
          aria-label="Roster home"
          onClick={() => {
            setView("Chats");
            setSelected(null);
          }}
        >
          <Mark size={34} />
          <span>
            roster<span className="brand-period">.</span>
          </span>
        </button>
        <button
          className="workspace-switch"
          onClick={() => setView("Settings")}
        >
          <span className="workspace-icon">P</span>
          <span>
            <strong>{state.settings.workspaceName}</strong>
            <small>Local workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <div className="nav-links">
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              aria-label={name}
              title={name}
              className={view === name ? "active" : ""}
              onClick={() => {
                setView(name);
                setProfile(false);
                setTaskId(null);
              }}
            >
              <Icon size={19} />
              <span>{name}</span>
              {name === "Roster" && state.agents.length > 0 && (
                <small>{state.agents.length}</small>
              )}
              {name === "Needs You" && needsYou > 0 && (
                <small className="attention">{needsYou}</small>
              )}
            </button>
          ))}
        </div>
        <div className="nav-bottom">
          <div className="local-note">
            <span className="tiny-dot" />
            <span>Your work. Your machine.</span>
          </div>
          <button
            className={`settings-nav ${view === "Settings" ? "active" : ""}`}
            aria-label="Settings"
            title="Settings"
            onClick={() => setView("Settings")}
          >
            <SettingsIcon size={19} />
            <span>Settings</span>
          </button>
          <button className="account" onClick={() => setView("Settings")}>
            <Avatar name="You" color="peach" />
            <span>
              <strong>Your workspace</strong>
              <small>Personal account</small>
            </span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </nav>
      <main className="main">
        {!connected && (
          <div className="connection-banner">
            <RefreshCw size={15} /> Reconnecting to your workspace. Saved work
            is safe.
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <IconButton label="Dismiss error" onClick={() => setError("")}>
              <X size={17} />
            </IconButton>
          </div>
        )}
        {view === "Chats" ? (
          <div className="messenger">
            <aside className="chat-list">
              <header className="list-header">
                <h1>Chats</h1>
                <div>
                  <IconButton
                    label="Search all messages"
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search size={19} />
                  </IconButton>
                  <IconButton label="New chat" onClick={() => setWorker({})}>
                    <PenLine size={19} />
                  </IconButton>
                </div>
              </header>
              <div className="search-field">
                <Search size={17} />
                <input
                  aria-label="Search chats"
                  placeholder="Search or start a conversation"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>⌘ K</kbd>
              </div>
              <div className="filters">
                {["All", "Unread", "Teams", "Working"].map((f) => (
                  <button
                    key={f}
                    className={filter === f ? "selected" : ""}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div className="conversation-rows">
                {conversations.map((c) => {
                  const a = state.agents.find((a) => a.id === c.agent_id);
                  const team = state.teams.find(
                    (team) => team.id === c.team_id,
                  );
                  const teamMembers = team
                    ? team.members
                        .map((memberId) =>
                          state.agents.find((member) => member.id === memberId),
                        )
                        .filter(Boolean)
                        .map((member) => ({
                          name: member!.name,
                          color: member!.color,
                          status: member!.status,
                        }))
                    : [];
                  const working = state.tasks.some(
                    (t) => t.conversation_id === c.id && t.status === "running",
                  );
                  return (
                    <button
                      key={c.id}
                      className={`conversation-row ${c.id === selected ? "selected" : ""}`}
                      onClick={() => openChat(c.id)}
                    >
                      <Avatar
                        name={c.name}
                        color={a?.color || "green"}
                        team={!!c.team_id}
                        status={working ? "working" : undefined}
                        members={teamMembers}
                      />
                      <span className="conversation-text">
                        <span className="conversation-title">
                          <strong>{c.name}</strong>
                          <time>{time(c.updated_at)}</time>
                        </span>
                        <span className="conversation-preview">
                          <span>
                            {working ? (
                              <>
                                <span className="tiny-dot" /> Working on it…
                              </>
                            ) : (
                              c.preview || a?.role || "Your team is ready"
                            )}
                          </span>
                          {c.pinned ? (
                            <Pin size={12} />
                          ) : c.unread > 0 ? (
                            <b>{c.unread}</b>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {!conversations.length && (
                  <div className="list-empty">
                    <div className="small-illustration">
                      <MessageCircle size={28} />
                      <span>+</span>
                    </div>
                    <h3>
                      {query
                        ? "No matching chats"
                        : state.conversations.length
                          ? "Nothing here yet"
                          : "Your team starts here"}
                    </h3>
                    <p>
                      {query
                        ? "Try another name."
                        : "Add your first worker and start a conversation."}
                    </p>
                    {!state.agents.length && (
                      <button
                        className="text-button"
                        onClick={() => setWorker({})}
                      >
                        Add to roster <ArrowRight size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button
                className={`archived-row ${filter === "Archived" ? "selected" : ""}`}
                onClick={() =>
                  setFilter(filter === "Archived" ? "All" : "Archived")
                }
              >
                <Archive size={17} /> Archived chats{" "}
                <span>
                  {state.conversations.filter((c) => c.archived).length || ""}
                </span>
              </button>
              <footer className="list-footer">
                <LockKeyhole size={13} /> Conversations saved on this device
              </footer>
            </aside>
            <section className="conversation">
              {conv ? (
                <>
                  <header className="conversation-header">
                    <IconButton
                      label="Back to chats"
                      className="mobile-back"
                      onClick={() => setSelected(null)}
                    >
                      <ChevronLeft size={22} />
                    </IconButton>
                    <button
                      className="contact-header"
                      onClick={() => setProfile(true)}
                    >
                      <Avatar
                        name={conv.name}
                        color={agent?.color || "green"}
                        team={!!currentTeam}
                        members={
                          currentTeam
                            ? currentTeam.members
                                .map((memberId) =>
                                  state.agents.find(
                                    (member) => member.id === memberId,
                                  ),
                                )
                                .filter(Boolean)
                                .map((member) => ({
                                  name: member!.name,
                                  color: member!.color,
                                  status: member!.status,
                                }))
                            : []
                        }
                      />
                      <span>
                        <strong>{conv.name}</strong>
                        <small>
                          {currentTeam
                            ? currentTeam.members
                                .map((memberId) =>
                                  state.agents.find(
                                    (member) => member.id === memberId,
                                  ),
                                )
                                .filter(Boolean)
                                .map(
                                  (member) =>
                                    `${member!.name} ${
                                      statusLabel[member!.status]
                                    }`,
                                )
                                .join(" · ")
                            : `${agent?.role || "Removed worker"} · ${busy ? "Working" : agent ? statusLabel[agent.status] : "History preserved"}`}
                        </small>
                      </span>
                    </button>
                    <div className="header-actions">
                      <IconButton
                        label="Search messages"
                        onClick={() => setSearchOpen(true)}
                      >
                        <Search size={20} />
                      </IconButton>
                      <IconButton
                        label="Chat options"
                        onClick={() => setMenu(!menu)}
                      >
                        <MoreHorizontal size={22} />
                      </IconButton>
                    </div>
                    {menu && (
                      <div className="chat-menu">
                        <button
                          onClick={() => {
                            act(() =>
                              api(`/conversations/${conv.id}`, "PATCH", {
                                pinned: !conv.pinned,
                              }),
                            );
                            setMenu(false);
                          }}
                        >
                          <Pin size={16} />
                          {conv.pinned ? "Unpin chat" : "Pin chat"}
                        </button>
                        <button
                          onClick={() => {
                            act(() =>
                              api(`/conversations/${conv.id}`, "PATCH", {
                                muted: !conv.muted,
                              }),
                            );
                            setMenu(false);
                          }}
                        >
                          {conv.muted ? "Unmute chat" : "Mute chat"}
                        </button>
                        <button
                          onClick={() => {
                            act(() =>
                              api(`/conversations/${conv.id}`, "PATCH", {
                                archived: !conv.archived,
                              }),
                            );
                            setMenu(false);
                          }}
                        >
                          <Archive size={16} />
                          {conv.archived ? "Unarchive chat" : "Archive chat"}
                        </button>
                        <button
                          onClick={() => {
                            setProfile(true);
                            setMenu(false);
                          }}
                        >
                          <UserRound size={16} />
                          Contact details
                        </button>
                      </div>
                    )}
                  </header>
                  <div
                    className="message-scroll wallpaper"
                    ref={scroll}
                    onScroll={() => {
                      const e = scroll.current;
                      if (e)
                        follow.current =
                          e.scrollHeight - e.scrollTop - e.clientHeight < 100;
                    }}
                  >
                    {hasOlder && (
                      <div className="older-messages">
                        <button
                          className="secondary"
                          disabled={loadingOlder}
                          onClick={loadOlder}
                        >
                          {loadingOlder
                            ? "Opening earlier messages…"
                            : "Load earlier messages"}
                        </button>
                      </div>
                    )}
                    <div className="chat-start">
                      <span>
                        {new Date(conv.updated_at).toLocaleDateString([], {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })}
                      </span>
                      <p>
                        <LockKeyhole size={12} /> Saved locally. Your connected
                        runtime processes messages.
                      </p>
                    </div>
                    {!messages.length && (
                      <div className="chat-intro">
                        <Avatar
                          name={conv.name}
                          color={agent?.color}
                          team={!!currentTeam}
                          size="large"
                          members={
                            currentTeam
                              ? currentTeam.members
                                  .map((memberId) =>
                                    state.agents.find(
                                      (member) => member.id === memberId,
                                    ),
                                  )
                                  .filter(Boolean)
                                  .map((member) => ({
                                    name: member!.name,
                                    color: member!.color,
                                    status: member!.status,
                                  }))
                              : []
                          }
                        />
                        <h2>Say hello to {conv.name}.</h2>
                        <p>
                          {agent?.description ||
                            currentTeam?.objective ||
                            "Your next piece of good work starts with a message."}
                        </p>
                        <button
                          className="suggestion"
                          onClick={() => {
                            setDraft(
                              `Hi ${conv.name}, tell me how you can help.`,
                            );
                            input.current?.focus();
                          }}
                        >
                          What can you help me with? <ArrowUpRight size={15} />
                        </button>
                      </div>
                    )}
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className={`message-row ${m.role === "user" ? "outgoing" : m.role === "system" ? "system" : "incoming"}`}
                      >
                        <div
                          className={`bubble ${m.status === "error" ? "bubble-error" : ""}`}
                        >
                          {m.role === "assistant" && currentTeam && (
                            <strong className="message-author">
                              {state.agents.find((a) => a.id === m.agent_id)
                                ?.name || "Worker"}
                            </strong>
                          )}
                          {m.reply_to && (
                            <div className="quoted">
                              {messages
                                .find((x) => x.id === m.reply_to)
                                ?.content.slice(0, 160) || "Earlier message"}
                            </div>
                          )}
                          {m.kind === "error" ? (
                            <div className="inline-error">
                              <AlertCircle size={16} />
                              {m.content}
                            </div>
                          ) : (
                            <Suspense fallback={<p>{m.content}</p>}>
                              <Markdown content={m.content} />
                            </Suspense>
                          )}
                          {m.status === "streaming" && !m.content && (
                            <span className="working-indicator">
                              <span />
                              <span />
                              <span /> Working
                            </span>
                          )}
                          {!!m.attachments?.length && (
                            <div className="message-attachments">
                              {m.attachments.map((a) => (
                                <a
                                  href={`/api/files/${a.id}`}
                                  download
                                  key={a.id}
                                >
                                  <Paperclip size={14} />
                                  {a.name}
                                  <ArrowUpRight size={13} />
                                </a>
                              ))}
                            </div>
                          )}
                          <div className="message-meta">
                            {["error", "interrupted", "cancelled"].includes(
                              m.status,
                            ) && (
                              <span>
                                {m.status === "error"
                                  ? "Couldn’t finish"
                                  : m.status === "cancelled"
                                    ? "Cancelled"
                                    : "Interrupted"}
                              </span>
                            )}
                            <time>{time(m.created_at)}</time>
                            {m.role === "user" && <CheckCheck size={15} />}
                          </div>
                          {m.content && m.kind !== "error" && (
                            <div className="message-tools">
                              <button
                                onClick={() => {
                                  setReply(m);
                                  input.current?.focus();
                                }}
                                title="Reply"
                              >
                                Reply
                              </button>
                              <button
                                onClick={() =>
                                  navigator.clipboard
                                    .writeText(m.content)
                                    .then(() => notify("Message copied"))
                                    .catch(() =>
                                      setError("Could not copy to clipboard."),
                                    )
                                }
                              >
                                Copy
                              </button>
                              {["👍", "✨", "✅"].map((reaction) => (
                                <button
                                  key={reaction}
                                  onClick={() =>
                                    act(() =>
                                      api(
                                        `/messages/${m.id}/reactions`,
                                        "POST",
                                        { emoji: reaction },
                                      ),
                                    )
                                  }
                                  title={`React with ${reaction}`}
                                >
                                  {reaction}
                                </button>
                              ))}
                            </div>
                          )}
                          {!!m.reactions?.length && (
                            <div className="message-reactions">
                              {m.reactions.map((reaction) => (
                                <span key={reaction}>{reaction}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {state.tasks
                      .filter(
                        (t) =>
                          t.conversation_id === selected &&
                          (t.kind !== "chat" ||
                            ["failed", "cancelled"].includes(t.status)),
                      )
                      .map((t) => (
                        <button
                          key={t.id}
                          className="task-chat-card"
                          onClick={() => setTaskId(t.id)}
                        >
                          <span className={`task-state-icon ${t.status}`}>
                            <CheckCheck size={20} />
                          </span>
                          <span>
                            <strong>{t.title}</strong>
                            <small>
                              {
                                state.agents.find((a) => a.id === t.owner_id)
                                  ?.name
                              }{" "}
                              · {statusLabel[t.status]}
                              {t.verification !== "unverified"
                                ? " · " + statusLabel[t.verification]
                                : ""}
                            </small>
                          </span>
                          <ArrowUpRight size={18} />
                        </button>
                      ))}
                    {state.approvals
                      .filter(
                        (a) =>
                          a.status === "pending" &&
                          state.tasks.find((t) => t.id === a.task_id)
                            ?.conversation_id === selected,
                      )
                      .map((a) => (
                        <div className="approval-card" key={a.id}>
                          <span>
                            <ShieldCheck size={20} /> Needs your approval
                          </span>
                          <h3>{a.title}</h3>
                          <pre>{a.detail}</pre>
                          <div>
                            <button
                              className="secondary"
                              onClick={() =>
                                act(() =>
                                  api(`/approvals/${a.id}`, "POST", {
                                    allow: false,
                                  }),
                                )
                              }
                            >
                              Decline
                            </button>
                            <button
                              className="primary"
                              onClick={() =>
                                act(() =>
                                  api(`/approvals/${a.id}`, "POST", {
                                    allow: true,
                                  }),
                                )
                              }
                            >
                              Approve
                            </button>
                          </div>
                        </div>
                      ))}
                    {state.planning.includes(selected || "") && (
                      <div className="planning-note">
                        <Activity size={15} /> Finding the right person for
                        this…
                      </div>
                    )}
                  </div>
                  <div className="composer-wrap">
                    {reply && (
                      <div className="reply-preview">
                        <span>
                          Replying to{" "}
                          {reply.role === "user" ? "yourself" : conv.name}
                          <small>{reply.content.slice(0, 100)}</small>
                        </span>
                        <IconButton
                          label="Cancel reply"
                          onClick={() => setReply(null)}
                        >
                          <X size={17} />
                        </IconButton>
                      </div>
                    )}
                    {attachments.length > 0 && (
                      <div className="attachment-chips">
                        {attachments.map((f, i) => (
                          <span key={i}>
                            <Paperclip size={13} />
                            {f.name}
                            <button
                              aria-label={`Remove ${f.name}`}
                              onClick={() =>
                                setAttachments((a) =>
                                  a.filter((_, n) => n !== i),
                                )
                              }
                            >
                              <X size={13} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {emoji && (
                      <div className="emoji-picker">
                        {["👍", "✨", "✅", "💡", "🙏", "🎯", "👋", "😊"].map(
                          (e) => (
                            <button
                              key={e}
                              onClick={() => {
                                setDraft((d) => d + e);
                                setEmoji(false);
                                input.current?.focus();
                              }}
                            >
                              {e}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                    {currentTeam && /@[^\s]*$/.test(draft) && (
                      <div className="mention-picker">
                        {state.agents
                          .filter(
                            (a) =>
                              currentTeam.members.includes(a.id) &&
                              a.name
                                .toLowerCase()
                                .startsWith(
                                  draft.split("@").pop()!.toLowerCase(),
                                ),
                          )
                          .map((a) => (
                            <button
                              key={a.id}
                              onClick={() => {
                                setDraft((d) =>
                                  d.replace(/@[^\s]*$/, `@${a.name} `),
                                );
                                input.current?.focus();
                              }}
                            >
                              <Avatar
                                name={a.name}
                                color={a.color}
                                size="small"
                              />
                              {a.name}
                              <small>{a.role}</small>
                            </button>
                          ))}
                      </div>
                    )}
                    <div className="composer">
                      <IconButton
                        label="Add text file"
                        onClick={() => fileInput.current?.click()}
                      >
                        <Plus size={24} />
                      </IconButton>
                      <IconButton
                        label="Emoji"
                        onClick={() => setEmoji(!emoji)}
                      >
                        <Smile size={21} />
                      </IconButton>
                      <textarea
                        ref={input}
                        aria-label={`Message ${conv.name}`}
                        placeholder={`Message ${conv.name}…`}
                        rows={1}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            send();
                          }
                        }}
                      />
                      {busy && (
                        <IconButton
                          label="Stop current work"
                          className="icon-button stop-work"
                          onClick={() =>
                            act(() =>
                              api(
                                `/conversations/${selected}/stop`,
                                "POST",
                                {},
                              ),
                            )
                          }
                        >
                          <Square size={18} />
                        </IconButton>
                      )}
                      <IconButton
                        label="Send message"
                        className="send-button"
                        onClick={send}
                        disabled={
                          !draft.trim() || sending || (!agent && !currentTeam)
                        }
                      >
                        <Send size={19} />
                      </IconButton>
                    </div>
                    <div className="composer-hint">
                      {busy
                        ? "Work is in progress. Send a constraint, context, or follow-up."
                        : "Enter to send · Shift + Enter for a new line"}
                    </div>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      accept="text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.html,.css,.yaml,.yml,.sql"
                      onChange={(e) => attach(e.target.files)}
                    />
                  </div>
                </>
              ) : (
                <Welcome
                  state={state}
                  onWorker={setWorker}
                  onSettings={() => setView("Settings")}
                />
              )}
            </section>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="page-loading">Opening {view.toLowerCase()}…</div>
            }
          >
            <WorkspaceView
              view={view}
              state={state}
              refresh={refresh}
              act={act}
              openChat={openChat}
              onWorker={setWorker}
              onTeam={setTeam}
              onTask={setTaskId}
              notify={notify}
            />
          </Suspense>
        )}
      </main>
      {worker && (
        <WorkerModal
          value={worker}
          onClose={() => setWorker(null)}
          onSave={async (data) => {
            const result = await api<{ conversationId: string }>(
              worker.id ? `/agents/${worker.id}` : "/agents",
              worker.id ? "PUT" : "POST",
              data,
            );
            await refresh();
            setWorker(null);
            if (result.conversationId) openChat(result.conversationId);
          }}
        />
      )}
      {team && (
        <TeamModal
          value={team}
          state={state}
          onClose={() => setTeam(null)}
          onSave={async (data) => {
            const result = await api<{ conversationId: string }>(
              team.id ? `/teams/${team.id}` : "/teams",
              team.id ? "PUT" : "POST",
              data,
            );
            await refresh();
            setTeam(null);
            openChat(result.conversationId);
          }}
        />
      )}
      {profile && conv && (
        <ProfilePanel
          agent={agent}
          team={currentTeam}
          state={state}
          onClose={() => setProfile(false)}
          onEdit={() => {
            setProfile(false);
            if (agent) setWorker(agent);
            else if (currentTeam) setTeam(currentTeam);
          }}
        />
      )}
      {taskId && (
        <TaskPanel
          id={taskId}
          state={state}
          onClose={() => setTaskId(null)}
          act={act}
        />
      )}{" "}
      {searchOpen && (
        <SearchModal
          state={state}
          onClose={() => setSearchOpen(false)}
          onOpen={(id) => {
            openChat(id);
            setSearchOpen(false);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Welcome({
  state,
  onWorker,
  onSettings,
}: {
  state: State;
  onWorker: (a: Partial<Agent>) => void;
  onSettings: () => void;
}) {
  const connected = state.providers.some((p) => p.status === "connected");
  return (
    <div className="welcome wallpaper">
      <div className="welcome-top">
        <span>
          <span className="tiny-dot" /> A little less busywork. A lot more done.
        </span>
        <span>YOUR AI WORKSPACE</span>
      </div>
      <div className="welcome-content">
        <div className="welcome-mark">
          <Mark size={64} />
          <span className="orbit-badge">
            <Check size={16} />
          </span>
        </div>
        <span className="eyebrow">MEET YOUR NEXT GREAT TEAM</span>
        <h1>
          Good work starts with
          <br />a conversation.
        </h1>
        <p>
          Your own AI workers. Familiar chats. A team that
          <br className="desktop-break" /> helps you take things from to-do to
          done.
        </p>
        <button className="primary welcome-cta" onClick={() => onWorker({})}>
          <Plus size={18} /> Add your first worker <ArrowRight size={17} />
        </button>
        <div className="template-divider">
          <span />A FEW GOOD PEOPLE TO START WITH
          <span />
        </div>
        <div className="welcome-templates">
          {templates.slice(0, 3).map((t) => (
            <button key={t.role} onClick={() => onWorker(t)}>
              <span className={`template-icon ${t.color}`}>
                <t.icon size={22} />
              </span>
              <h3>
                {t.role === "QA / Reviewer"
                  ? "A second pair of eyes"
                  : t.role === "Software Engineer"
                    ? "Your go-to engineer"
                    : "Your curious researcher"}
              </h3>
              <p>{t.description}</p>
              <span className="template-link">
                Meet {t.name} <ArrowUpRight size={14} />
              </span>
            </button>
          ))}
        </div>
        <button className="runtime-status" onClick={onSettings}>
          <span className={`runtime-dot ${connected ? "ready" : ""}`} />
          <span>
            {connected ? "Codex is connected" : "Connect your AI runtime"}
          </span>
          <span className="subtle">
            {connected
              ? "You’re ready when you are."
              : "One connection. Your whole roster."}
          </span>
          <ArrowUpRight size={14} />
        </button>
      </div>
      <footer className="welcome-footer">
        <LockKeyhole size={13} /> Your conversations stay on this device.{" "}
        <span>Built around you.</span>
      </footer>
    </div>
  );
}
const WorkspaceView = lazy(() => import("./workspace"));
const WorkerModal = lazy(() =>
  import("./panels").then((m) => ({ default: m.WorkerModal })),
);
const TeamModal = lazy(() =>
  import("./panels").then((m) => ({ default: m.TeamModal })),
);
const ProfilePanel = lazy(() =>
  import("./panels").then((m) => ({ default: m.ProfilePanel })),
);
const TaskPanel = lazy(() =>
  import("./panels").then((m) => ({ default: m.TaskPanel })),
);
const SearchModal = lazy(() =>
  import("./panels").then((m) => ({ default: m.SearchModal })),
);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense
      fallback={
        <div className="boot">
          <Mark size={56} />
        </div>
      }
    >
      <App />
    </Suspense>
  </React.StrictMode>,
);
