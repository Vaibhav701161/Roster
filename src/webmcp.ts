type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};
type Context = {
  registerTool: (
    tool: Tool,
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function registerRosterTools(actions: {
  read: () => unknown;
  create: (name: string, role: string) => Promise<unknown>;
  open: (id: string) => unknown;
}) {
  const context = (document as Document & { modelContext?: Context })
    .modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const tools: Tool[] = [
    {
      name: "roster_read_workers",
      title: "Read your roster",
      description:
        "List the current workers and their real availability. No messages or credentials are returned.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => actions.read(),
    },
    {
      name: "roster_create_worker",
      title: "Create a worker",
      description:
        "Create and persist a worker with a name and role, then open its direct conversation. Does not send a message or grant project access.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          role: { type: "string", minLength: 1, maxLength: 100 },
        },
        required: ["name", "role"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input) => {
        const value = input as { name?: unknown; role?: unknown };
        if (
          typeof value?.name !== "string" ||
          typeof value?.role !== "string" ||
          !value.name.trim() ||
          !value.role.trim() ||
          value.name.length > 100 ||
          value.role.length > 100
        )
          throw new Error(
            "Provide a name and role, each between 1 and 100 characters.",
          );
        return actions.create(value.name, value.role);
      },
    },
    {
      name: "roster_open_conversation",
      title: "Open a conversation",
      description:
        "Navigate to an existing conversation without sending a message.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: (input) => {
        const id = (input as { id?: unknown })?.id;
        if (typeof id !== "string")
          throw new Error("A conversation ID is required.");
        return actions.open(id);
      },
    },
  ];
  for (const tool of tools) {
    try {
      Promise.resolve(
        context.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {
      /* Unsupported browser contexts leave normal UI functionality intact. */
    }
  }
  return () => lifecycle.abort();
}
