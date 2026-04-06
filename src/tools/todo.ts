/**
 * Todo Tool — Manage a todo list for multi-step tasks.
 *
 * The agent can use this to:
 * - Plan research tasks upfront
 * - Track progress as it works
 * - Remember what still needs to be done
 */
import { Type, StringEnum } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoState {
  todos: Todo[];
  nextId: number;
}

// In-memory state per user session
const todoStates = new Map<string, TodoState>();

function getState(sessionId: string): TodoState {
  if (!todoStates.has(sessionId)) {
    todoStates.set(sessionId, { todos: [], nextId: 1 });
  }
  return todoStates.get(sessionId)!;
}

export const todoTool: ToolDefinition = {
  name: "todo",
  label: "Todo",
  description: `Manage a todo list for tracking multi-step tasks. Use this for research tasks, audits, or any task with 3+ distinct steps.

Actions:
- list: Show all todos
- add: Add a new todo (requires text)
- toggle: Mark a todo as done/undone (requires id)
- clear: Remove all todos

Example workflow:
1. Add todos for each research step
2. Mark them done as you complete them
3. User can see your progress`,

  parameters: Type.Object({
    action: StringEnum(["list", "add", "toggle", "clear"] as const, {
      description: "Action to perform",
    }),
    text: Type.Optional(Type.String({ description: "Todo text (for add action)" })),
    id: Type.Optional(Type.Number({ description: "Todo ID (for toggle action)" })),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const sessionId = (ctx as unknown as { sessionId?: string }).sessionId ?? "default";
    const state = getState(sessionId);
    const { action, text, id } = params as { action: "list" | "add" | "toggle" | "clear"; text?: string; id?: number };

    switch (action) {
      case "list": {
        if (state.todos.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No todos. Use 'add' to create some." }],
            details: { action: "list", todos: [], nextId: state.nextId },
          };
        }
        const lines = state.todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`);
        const completed = state.todos.filter((t) => t.done).length;
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { action: "list", todos: [...state.todos], nextId: state.nextId, completed, total: state.todos.length },
        };
      }

      case "add": {
        if (!text) {
          return {
            content: [{ type: "text" as const, text: "Error: text required for add action" }],
            details: { action: "add", todos: [...state.todos], nextId: state.nextId, error: "text required" },
            isError: true,
          };
        }
        const newTodo: Todo = { id: state.nextId++, text, done: false };
        state.todos.push(newTodo);
        return {
          content: [{ type: "text" as const, text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
          details: { action: "add", todos: [...state.todos], nextId: state.nextId },
        };
      }

      case "toggle": {
        if (id === undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: id required for toggle action" }],
            details: { action: "toggle", todos: [...state.todos], nextId: state.nextId, error: "id required" },
            isError: true,
          };
        }
        const todo = state.todos.find((t) => t.id === id);
        if (!todo) {
          return {
            content: [{ type: "text" as const, text: `Todo #${id} not found` }],
            details: { action: "toggle", todos: [...state.todos], nextId: state.nextId, error: `todo #${id} not found` },
            isError: true,
          };
        }
        todo.done = !todo.done;
        return {
          content: [{ type: "text" as const, text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}: ${todo.text}` }],
          details: { action: "toggle", todos: [...state.todos], nextId: state.nextId },
        };
      }

      case "clear": {
        const count = state.todos.length;
        state.todos = [];
        state.nextId = 1;
        return {
          content: [{ type: "text" as const, text: `Cleared ${count} todos` }],
          details: { action: "clear", todos: [], nextId: 1 },
        };
      }

      default: {
        return {
          content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
          details: { action: "list", todos: [...state.todos], nextId: state.nextId, error: `unknown action: ${action}` },
          isError: true,
        };
      }
    }
  },
};
